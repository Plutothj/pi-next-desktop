// Electron main process: owns the `pi --mode rpc` child process and bridges
// its JSONL protocol to the renderer over IPC.

import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as config from "./config.js";

// ---------------------------------------------------------------- runtime

// Electron ships a Node runtime that can be reused as a plain interpreter.
const ELECTRON_AS_NODE = { node: process.execPath, args: [], asNode: true };

function whichSync(bin) {
  // Windows resolves executables through PATHEXT. exe/.cmd/.bat, not X_OK.
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  const mode = process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try { fs.accessSync(candidate, mode); return candidate; } catch {}
    }
  }
  return null;
}

// Locate pi's CLI entry and a Node >= 22 to run it. Packaged builds ship both
// under Resources/runtime; otherwise fall back to the managed install.
function resolveRuntime() {
  const bundled = path.join(process.resourcesPath ?? "", "runtime");
  if (fs.existsSync(path.join(bundled, "cli.js"))) {
    const bundledNode = path.join(bundled, "bin", "node");
    const node = fs.existsSync(bundledNode) ? bundledNode : null;
    const env = {
      NODE_PATH: path.join(bundled, "vendor"),
      ...(node ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    };
    return { cli: path.join(bundled, "cli.js"), installRoot: null, ...(node ? { node, env } : { ...ELECTRON_AS_NODE, env }) };
  }

  if (process.env.PI_CLI) {
    return { node: process.env.PI_NODE || whichSync("node") || process.execPath, cli: process.env.PI_CLI, installRoot: null, env: {} };
  }

  const installRoot = path.join(os.homedir(), ".pi", "agent", "install");
  const version = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
  const cli = path.join(
    installRoot, "releases", version, "node_modules",
    "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
  );
  const dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const managedNode = path.join(dataDir, "pi-node", "current", "bin", "node");
  const node = fs.existsSync(managedNode) ? managedNode : whichSync("node") || process.execPath;
  const env = node === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  return { node, cli, installRoot, env };
}

// ---------------------------------------------------------------- rpc child

let child = null;
let win = null;
let nextId = 1;
const pending = new Map();

// Tells the agent that long-running commands belong to the desktop's task
// panel. Scoped to sessions this app spawns (--append-system-prompt).
const PI_BG_INSTRUCTIONS =
  "Background tasks: this session runs inside the Pi Desktop app, which has a terminal panel for " +
  "long-running processes. Do not run dev servers, watchers, or long builds synchronously in bash. " +
  'Start them with `pi-bg "<command>"` (options: --cwd DIR, --label TEXT); it returns a task id. ' +
  "Check with `pi-bg --list` or `pi-bg --output <id>`, block with `pi-bg --wait <id>`, stop with " +
  "`pi-bg --kill <id>`. The task keeps running after your turn and appears in the user's UI. " +
  "Keep ordinary short commands in the normal bash tool.";

function startPi(cwd) {
  stopPi();
  const rt = resolveRuntime();
  // Keep a local reference: the old process's exit handler must never touch
  // the new one during a restart (that used to null out the live child).
  const proc = spawn(
    rt.node,
    [rt.cli, "--mode", "rpc", "--append-system-prompt", PI_BG_INSTRUCTIONS],
    {
      cwd,
      env: {
        ...process.env,
        ...rt.env,
        // pi-bg must resolve from the agent's bash tool.
        PATH: [termBinDir(), path.dirname(rt.node), process.env.PATH ?? ""].join(path.delimiter),
        PI_DESKTOP_TERM_SOCK: termSockPath(),
        ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child = proc;

  // Split strictly on LF. Node's readline also splits on U+2028/U+2029, which
  // are legal inside JSON strings.
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      handleRecord(line);
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => process.stderr.write(d));

  proc.on("exit", (code, signal) => {
    // A superseded process exiting during a restart is not news.
    if (child !== proc) return;
    child = null;
    for (const { reject } of pending.values()) reject(new Error("pi exited"));
    pending.clear();
    pendingDialogs.clear();
    send({ type: "ui_dialog_clear" });
    send({ type: "child_exit", code, signal });
  });
}

function stopPi() {
  if (!child) return;
  const dying = child;
  child = null;
  pendingDialogs.clear();
  send({ type: "ui_dialog_clear" });
  try { dying.stdin.end(); } catch {}
  // Commands aimed at the old process will never be answered.
  for (const { reject } of pending.values()) reject(new Error("pi 重启中"));
  pending.clear();
  setTimeout(() => { try { dying.kill("SIGKILL"); } catch {} }, 1500);
}

function send(record) {
  if (win && !win.isDestroyed()) win.webContents.send("pi:event", record);
}

function handleRecord(line) {
  let rec;
  try { rec = JSON.parse(line); } catch {
    send({ type: "client_error", message: `无法解析 pi 输出: ${line.slice(0, 200)}` });
    return;
  }

  if (rec.type === "response" && rec.id && pending.has(rec.id)) {
    const { resolve, reject } = pending.get(rec.id);
    pending.delete(rec.id);
    rec.success ? resolve(rec) : reject(new Error(rec.error || "command failed"));
    return;
  }

  if (rec.type === "extension_ui_request") {
    handleExtensionUi(rec);
    return;
  }

  send(rec);
}

// Extension text is written for a TUI; strip CSI/OSC escapes and control chars.
function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

// Dialog requests block pi until answered, so every one of them gets a reply.
function handleExtensionUi(req) {
  const reply = (values) => {
    try {
      child?.stdin.write(JSON.stringify({ type: "extension_ui_response", id: req.id, ...values }) + "\n");
    } catch {}
  };

  if (req.method === "confirm") {
    dialog.showMessageBox(win, {
      type: "question",
      title: req.title ?? "Pi",
      message: req.title ?? "确认",
      detail: req.message ?? "",
      buttons: ["取消", "确认"],
      defaultId: 1,
      cancelId: 0,
    }).then(({ response }) => reply({ confirmed: response === 1 }));
    return;
  }
  if (req.method === "notify") {
    send({ type: "ui_notify", message: req.message, notifyType: req.notifyType ?? "info" });
    return;
  }
  if (req.method === "setTitle") {
    send({ type: "ui_title", title: req.title });
    return;
  }
  // Extensions use setStatus to push live status text (e.g. a git extension's
  // current branch). An empty statusText means "clear this key". Extensions
  // write for a TUI, so strip ANSI escapes before showing it in the UI.
  if (req.method === "setStatus") {
    send({ type: "ui_status", key: req.statusKey, text: stripAnsi(req.statusText) });
    return;
  }
  if (req.method === "setWidget") {
    send({ type: "ui_widget", key: req.widgetKey, lines: (req.widgetLines ?? []).map(stripAnsi) });
    return;
  }
  // select / input / editor are answered from the renderer; pi keeps the
  // request open until pi:uiRespond writes the matching response.
  if (["select", "input", "editor"].includes(req.method)) {
    pendingDialogs.add(req.id);
    send({
      type: "ui_dialog",
      dialog: {
        id: req.id,
        method: req.method,
        title: req.title,
        options: req.options,
        placeholder: req.placeholder,
        prefill: req.prefill,
      },
    });
  }
}

const pendingDialogs = new Set();

ipcMain.handle("pi:uiRespond", (_e, { id, value, cancelled, confirmed }) => {
  if (!pendingDialogs.has(id)) return { ok: false, error: "请求已失效" };
  pendingDialogs.delete(id);
  const payload = { type: "extension_ui_response", id };
  if (cancelled) payload.cancelled = true;
  else if (confirmed !== undefined) payload.confirmed = Boolean(confirmed);
  else payload.value = typeof value === "string" ? value : "";
  try {
    child?.stdin.write(JSON.stringify(payload) + "\n");
  } catch {}
  return { ok: true };
});

// Dev-only helper so the dialog UI can be exercised without an extension.
if (process.env.PI_DEBUG) {
  ipcMain.handle("pi:debugDialog", (_e, dialog) => {
    const id = `debug-${Date.now()}`;
    pendingDialogs.add(id);
    send({ type: "ui_dialog", dialog: { ...dialog, id } });
    return { ok: true, id };
  });
}

function command(payload) {
  if (!child) return Promise.reject(new Error("pi 未运行"));
  const id = String(nextId++);
  const record = { id, ...payload };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(JSON.stringify(record) + "\n");
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 620,
    minHeight: 420,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#14151a",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  if (process.env.PI_DEV_URL) {
    win.loadURL(process.env.PI_DEV_URL);
  } else {
    win.loadFile(path.join(import.meta.dirname, "..", "dist", "index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---------------------------------------------------------------- ipc

ipcMain.handle("pi:start", async (_e, { cwd }) => {
  const resolved = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  startPi(resolved);
  // Cold start: get_state can answer before the session/model exist, so poll.
  let state = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    state = await command({ type: "get_state" }).catch((e) => ({ error: String(e) }));
    if (process.env.PI_DEBUG) console.error("[boot poll]", i, JSON.stringify(state).slice(0, 200));
    if (state?.data?.model) break;
  }
  const [models, messages] = await Promise.all([
    command({ type: "get_available_models" }).catch(() => null),
    command({ type: "get_messages" }).catch(() => null),
  ]);
  return {
    state: state?.data ?? null,
    models: models?.data?.models ?? [],
    messages: messages?.data?.messages ?? [],
    cwd: resolved,
  };
});

ipcMain.handle("pi:send", async (_e, payload) => {
  const res = await command(payload);
  return res.data ?? null;
});

ipcMain.handle("pi:pickFolder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: os.homedir(),
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("pi:reveal", (_e, target) => shell.openPath(target));

// pi has no "list sessions" RPC command, so read the session directory directly.
// Each file starts with a JSON header line: {type:"session",id,timestamp,cwd}.
function sessionTitle(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = raw.split("\n");
  let header = null;
  let title = null;
  const changed = { added: 0, removed: 0 };
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    // Cheap substring pre-filters before JSON.parse: renames (session_info),
    // the first user message (only until a title exists), and tool calls
    // (the only records that change files).
    if (index > 0) {
      const mayRename = line.includes('"session_info"');
      const mayUser = !title && line.includes('"role":"user"');
      const mayTool = line.includes('"toolCall"');
      if (!mayRename && !mayUser && !mayTool) continue;
    }
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "session" && !header) header = rec;
    // Renames append a session_info entry; the last one wins.
    if (rec.type === "session_info" && rec.name) title = rec.name;
    if (!title && rec.type === "message" && rec.message?.role === "user") {
      const c = rec.message.content;
      const text = typeof c === "string" ? c : c?.find((b) => b.type === "text")?.text;
      if (text) title = text.replace(/\s+/g, " ").slice(0, 80);
    }
    if (rec.type === "message" && rec.message?.role === "assistant") {
      for (const block of rec.message.content ?? []) {
        if (block?.type !== "toolCall") continue;
        const args = block.arguments ?? {};
        const linesOf = (text) => (typeof text === "string" ? text.split("\n").length : 0);
        if (block.name === "write") changed.added += linesOf(args.content);
        if (block.name === "edit") {
          for (const edit of args.edits ?? [{ oldText: args.oldText, newText: args.newText }]) {
            changed.removed += linesOf(edit?.oldText);
            changed.added += linesOf(edit?.newText);
          }
        }
      }
    }
  }
  if (!header) return null;
  return {
    path: file,
    ...header,
    title: title ?? "新会话",
    mtime: fs.statSync(file).mtimeMs,
    changed,
  };
}

function scanSessions() {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const info = sessionTitle(path.join(root, dir.name, name));
      if (info) out.push(info);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

ipcMain.handle("pi:sessions", () => scanSessions());

// ---------------------------------------------------------------- projects
// Projects are first-class: manually opened folders persist even before they
// have any sessions, and session cwds are merged in as implicit projects.

const projectsFile = () => path.join(app.getPath("userData"), "projects.json");

function readProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8"));
    return Array.isArray(raw?.projects)
      ? raw.projects.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function writeProjects(projects) {
  try {
    fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
    fs.writeFileSync(projectsFile(), JSON.stringify({ projects }, null, 2));
  } catch (err) {
    console.error("failed to write projects.json", err);
  }
}

ipcMain.handle("projects:list", () => {
  const byPath = new Map();
  for (const s of scanSessions()) {
    const entry = byPath.get(s.cwd) ?? { path: s.cwd, sessions: 0, mtime: 0, stored: false };
    entry.sessions += 1;
    entry.mtime = Math.max(entry.mtime, s.mtime);
    byPath.set(s.cwd, entry);
  }
  for (const p of readProjects()) {
    const entry = byPath.get(p) ?? { path: p, sessions: 0, mtime: 0, stored: false };
    entry.stored = true;
    byPath.set(p, entry);
  }
  return [...byPath.values()]
    .map((p) => ({
      ...p,
      name: path.basename(p.path) || p.path,
      exists: fs.existsSync(p.path),
    }))
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
});

ipcMain.handle("projects:add", (_e, dir) => {
  try {
    if (typeof dir !== "string" || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: "目录不存在" };
    }
    const stored = readProjects();
    if (!stored.includes(dir)) writeProjects([dir, ...stored].slice(0, 50));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("projects:remove", (_e, dir) => {
  writeProjects(readProjects().filter((p) => p !== dir));
  return { ok: true };
});

// pi's RPC fork only branches *before a user message*. For forking at an
// arbitrary entry (e.g. an assistant reply) we build the new session file
// ourselves — same JSONL format: header + the parent chain up to the entry —
// then let pi switch_session onto it.
ipcMain.handle("pi:forkSessionAt", async (_e, { entryId }) => {
  try {
    if (typeof entryId !== "string" || !entryId) return { ok: false, error: "无效的条目" };
    const state = await command({ type: "get_state" });
    const sessionFile = state?.data?.sessionFile;
    if (!sessionFile) return { ok: false, error: "当前会话还没有落盘，无法分支" };
    const entriesRes = await command({ type: "get_entries" });
    const entries = entriesRes?.data?.entries ?? [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const target = byId.get(entryId);
    if (!target) return { ok: false, error: "找不到该条目" };

    // Walk parentId back to the root; that chain is the branch to keep.
    const chain = [];
    for (let cur = target; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) {
      chain.unshift(cur);
    }

    const raw = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    const header = JSON.parse(raw[0]);
    if (header?.type !== "session") return { ok: false, error: "会话文件格式异常" };

    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const newHeader = { ...header, id: newId, timestamp: now, parentSession: header.id };
    const fileTimestamp = now.replace(/[:.]/g, "-");
    const newFile = path.join(path.dirname(sessionFile), `${fileTimestamp}_${newId}.jsonl`);
    const lines = [JSON.stringify(newHeader), ...chain.map((entry) => JSON.stringify(entry))];
    fs.writeFileSync(newFile, `${lines.join("\n")}\n`);

    const switched = await command({ type: "switch_session", sessionPath: newFile }).catch((err) => {
      // Don't leave a broken file behind if pi rejects it.
      try { fs.unlinkSync(newFile); } catch {}
      throw err;
    });
    if (switched?.data?.cancelled) {
      try { fs.unlinkSync(newFile); } catch {}
      return { ok: false, error: "分支被取消" };
    }
    return { ok: true, sessionFile: newFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// No delete RPC exists; remove the file ourselves. Deleting the live session
// would leave pi writing to a ghost file, so switch it to a fresh one first.
ipcMain.handle("pi:deleteSession", async (_e, { path: file }) => {
  try {
    const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
    if (typeof file !== "string" || !file.endsWith(".jsonl") || !file.startsWith(sessionsRoot + path.sep)) {
      return { ok: false, error: "非法的会话文件路径" };
    }
    let switched = false;
    const state = await command({ type: "get_state" }).catch(() => null);
    if (state?.data?.sessionFile === file) {
      await command({ type: "new_session" });
      switched = true;
    }
    fs.unlinkSync(file);
    return { ok: true, switched };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------- config

// Config edits only take effect in a freshly started pi, so callers restart it.
const afterChange = () => ({ ok: true, restart: true });

ipcMain.handle("cfg:read", (_e, { cwd } = {}) => {
  const settings = config.readSettings();
  return {
    settings,
    providers: config.listProviders(),
    packages: config.listPackages(),
    skills: config.listSkills(cwd),
    mcp: config.listMcp(),
    prompts: config.listPrompts(cwd),
    memory: config.listMemory(),
    persona: config.readPersona(cwd),
    apiKinds: config.API_KINDS,
    agentDir: config.AGENT_DIR,
  };
});

ipcMain.handle("cfg:setMcp", (_e, { name, enabled }) => {
  try {
    return config.setMcpEnabled(name, enabled);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("cfg:savePersona", (_e, payload) => {
  try {
    return config.writePersona(payload);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("cfg:saveProvider", (_e, payload) => {
  try {
    config.saveProvider(payload);
    return afterChange();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("cfg:deleteProvider", (_e, name) => {
  config.deleteProvider(name);
  return afterChange();
});

ipcMain.handle("cfg:setSetting", (_e, patch) => {
  // A bare string here used to spread into per-character keys and wreck settings.json.
  if (typeof patch !== "object" || patch === null) throw new Error("cfg:setSetting 需要一个 { key: value } 对象");
  const settings = config.readSettings();
  for (const [key, value] of Object.entries(patch ?? {})) {
    const parts = key.split(".");
    let node = settings;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part];
    }
    const last = parts.at(-1);
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
  }
  config.writeSettings(settings);
  return { ok: true, restart: true };
});

ipcMain.handle("cfg:gallery", (_e, query) => config.searchGallery(query).catch((err) => ({ error: err.message })));

ipcMain.handle("cfg:readSkill", (_e, file) => fs.readFileSync(file, "utf8"));

ipcMain.handle("cfg:deleteSkill", (_e, dir) => {
  try {
    config.deleteSkill(dir);
    return afterChange();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("cfg:setResources", (_e, { source, disabled }) => {
  config.setPackageResources(source, disabled);
  return afterChange();
});

// `pi install` shelling out: pi's own resolver owns the npm tree, so don't
// reimplement it. Output is streamed so the UI can show progress.
function runPi(args) {
  const rt = resolveRuntime();
  return new Promise((resolve) => {
    const proc = spawn(rt.node, [rt.cli, ...args], {
      env: {
        ...process.env,
        ...rt.env,
        PATH: [path.dirname(rt.node), process.env.PATH ?? ""].join(path.delimiter),
        ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const onData = (d) => {
      const text = d.toString();
      log += text;
      send({ type: "cfg_progress", line: text.trimEnd() });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => resolve({ ok: false, error: err.message, log }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, log }));
  });
}

ipcMain.handle("cfg:install", async (_e, source) => {
  const res = await runPi(["install", source]);
  return { ...res, ...afterChange() };
});

ipcMain.handle("cfg:uninstall", async (_e, source) => {
  const res = await runPi(["remove", source]);
  if (!res.ok) config.removePackageEntry(source);
  return { ...res, ...afterChange() };
});

// ---------------------------------------------------------------- files

// Bounded walk for @-mentions: enough for autocomplete, cheap on big repos.
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "release", ".venv", "__pycache__"]);

function listFiles(root, limit = 4000) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(full, depth + 1);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root, 0);
  return out;
}

ipcMain.handle("files:search", (_e, { cwd, query }) => {
  const files = listFiles(cwd);
  const q = (query ?? "").toLowerCase();
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const idx = q ? lower.indexOf(q) : 0;
    if (idx === -1) continue;
    const base = lower.slice(Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1);
    scored.push({ file, score: (base.startsWith(q) ? 0 : 100) + idx });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 40).map((s) => s.file);
});

// ---------------------------------------------------------------- git
// Branch info is read straight from git, independent of any pi extension.
// GIT_TERMINAL_PROMPT=0 keeps a credential prompt from hanging the child.

function git(dir, args) {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
  });
}

function gitDir(cwd) {
  return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
}

ipcMain.handle("git:status", async (_e, { cwd }) => {
  const res = await git(gitDir(cwd), ["status", "--porcelain=v2", "--branch"]);
  if (!res.ok) return { isRepo: false, error: res.error ?? res.stderr?.trim() };
  const lines = res.stdout.split("\n");
  const head = lines.find((l) => l.startsWith("# branch.head "))?.slice("# branch.head ".length) ?? "";
  const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length) ?? "";
  // "# branch.ab +2 -1" (absent when there is no upstream)
  const ab = lines.find((l) => l.startsWith("# branch.ab ")) ?? "";
  const ahead = Number(ab.match(/\+(\d+)/)?.[1] ?? 0);
  const behind = Number(ab.match(/-(\d+)/)?.[1] ?? 0);
  const detached = head === "(detached)";
  // Entries (1/2/u = changed, ? = untracked) mean a dirty tree; headers start with #.
  const dirty = lines.some((l) => /^[12u?]\s/.test(l));
  return {
    isRepo: true,
    branch: detached ? oid.slice(0, 7) || "detached" : head,
    detached,
    ahead,
    behind,
    dirty,
  };
});

ipcMain.handle("git:branches", async (_e, { cwd }) => {
  const res = await git(gitDir(cwd), [
    "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads",
  ]);
  if (!res.ok) return { branches: [], error: res.stderr?.trim() };
  return { branches: res.stdout.split("\n").map((s) => s.trim()).filter(Boolean) };
});

ipcMain.handle("git:checkout", async (_e, { cwd, branch }) => {
  if (typeof branch !== "string" || !branch.trim()) return { ok: false, error: "无效的分支名" };
  const dir = gitDir(cwd);
  // `switch` is clearer but only exists in git >= 2.23; fall back to checkout.
  let res = await git(dir, ["switch", branch]);
  if (!res.ok) res = await git(dir, ["checkout", branch]);
  return res.ok ? { ok: true } : { ok: false, error: (res.stderr || res.error || `退出码 ${res.code}`).trim() };
});

// ---------------------------------------------------------------- tasks
// Long commands run detached from pi's RPC turn so the agent can keep going.
// Plain pipes, not a PTY: interactive full-screen programs need node-pty.
const tasks = new Map();
let taskId = 1;
const MAX_OUTPUT = 200_000;

const publicTask = ({ kill, ...rest }) => rest;

function startTask({ cmd, cwd, label, host, origin = "user" }) {
  const id = String(taskId++);
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = host
    ? ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, cmd]]
    : process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmd]]
      // Linux may not ship zsh; honour $SHELL, then fall back to sh.
      : [process.env.SHELL || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh"), ["-lc", cmd]];
  const proc = spawn(shell[0], shell[1], {
    cwd: dir,
    env: {
      ...process.env,
      TERM: "dumb",
      FORCE_COLOR: "0",
      // Tasks (and anything they spawn) can start nested background tasks.
      PI_DESKTOP_TERM_SOCK: termSockPath(),
      PATH: [termBinDir(), process.env.PATH ?? ""].join(path.delimiter),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task = {
    id,
    cmd,
    label: host ? `${host}: ${label ?? cmd.slice(0, 50)}` : label ?? cmd.slice(0, 60),
    cwd: dir,
    host: host ?? null,
    origin,
    status: "running",
    startedAt: Date.now(),
    exitCode: null,
    output: "",
  };
  tasks.set(id, task);
  // Silent tasks (sleep, servers with no output yet) still need to show up.
  send({ type: "term_add", task: publicTask(task) });

  const append = (chunk) => {
    task.output += chunk;
    if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(-MAX_OUTPUT);
  };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => { append(d); send({ type: "term_data", id, chunk: d }); });
  proc.stderr.on("data", (d) => { append(d); send({ type: "term_data", id, chunk: d }); });
  proc.on("error", (err) => {
    task.status = "failed";
    append(`\n${err.message}\n`);
    send({ type: "term_exit", id, code: -1 });
  });
  proc.on("exit", (code, signal) => {
    task.status = code === 0 ? "done" : "failed";
    task.exitCode = code;
    task.signal = signal;
    task.endedAt = Date.now();
    send({ type: "term_exit", id, code, signal });
  });
  task.kill = () => {
    try {
      if (process.platform === "win32" && proc.pid) {
        // On Windows a signal only hits the shell; kill the whole tree.
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      } else {
        proc.kill("SIGTERM");
      }
    } catch {}
  };
  return task;
}

ipcMain.handle("term:run", (_e, { cmd, cwd, label, host }) => {
  const task = startTask({ cmd, cwd, label, host, origin: "user" });
  return { id: task.id, cwd: task.cwd };
});

ipcMain.handle("ssh:hosts", () => {
  const file = path.join(os.homedir(), ".ssh", "config");
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const hosts = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*Host\s+(.+)$/i);
    if (!match) continue;
    for (const host of match[1].split(/\s+/)) {
      if (host && !host.includes("*") && !host.startsWith("!")) hosts.push(host);
    }
  }
  return [...new Set(hosts)];
});

ipcMain.handle("term:list", () =>
  [...tasks.values()].map(({ kill, ...rest }) => rest),
);

ipcMain.handle("term:out", (_e, id) => tasks.get(id)?.output ?? "");

ipcMain.handle("term:kill", (_e, id) => {
  tasks.get(id)?.kill?.();
  return { ok: true };
});

ipcMain.handle("term:remove", (_e, id) => {
  tasks.get(id)?.kill?.();
  tasks.delete(id);
  return { ok: true };
});

// ---------------------------------------------------------------- term bridge
// pi's bash tool has no background mode, so the agent gets a CLI: `pi-bg`
// posts a job over a local Unix socket into the same task table the UI uses.

// Node speaks named pipes with the same net API on Windows, and AF_UNIX is
// not uniformly available there, so pick the platform-native endpoint.
const termSockPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\pi-desktop-term-${os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "")}`
    : path.join(app.getPath("userData"), "term.sock");
const termBinDir = () => path.join(app.getPath("userData"), "bin");
const termBinPath = () => path.join(termBinDir(), "pi-bg");

// The CLI is plain CommonJS and only depends on node:net.
const PI_BG_SOURCE = `#!/usr/bin/env node
"use strict";
const net = require("node:net");
const sock = process.env.PI_DESKTOP_TERM_SOCK;

const usage = 'usage: pi-bg "<command>" [--cwd DIR] [--label TEXT] [--host HOST]\\n' +
  "       pi-bg --list | --output ID | --kill ID | --wait ID [--timeout SECONDS]";

async function main() {
  if (!sock) {
    console.error("PI_DESKTOP_TERM_SOCK is not set; run this inside Pi Desktop.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (["--cwd", "--label", "--host", "--timeout", "--kill", "--output", "--wait"].includes(a)) {
      flags[a.slice(2)] = args[++i];
    } else if (a.startsWith("--") && a.length > 2) {
      flags[a.slice(2)] = true;
    } else {
      words.push(a);
    }
  }
  let payload;
  let timeoutMs = 15000;
  if (flags.list) payload = { op: "list" };
  else if (flags.kill) payload = { op: "kill", id: String(flags.kill) };
  else if (flags.output) payload = { op: "output", id: String(flags.output) };
  else if (flags.wait) {
    payload = { op: "wait", id: String(flags.wait), timeoutSeconds: Number(flags.timeout || 60) };
    timeoutMs = (Number(flags.timeout || 60) + 5) * 1000;
  } else {
    const command = words.join(" ");
    if (!command) { console.error(usage); process.exit(2); }
    payload = { op: "run", command, cwd: flags.cwd, label: flags.label, host: flags.host };
  }

  const res = await new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    let buf = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, timeoutMs);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\\n"));
    socket.on("data", (d) => { buf += d.toString(); });
    socket.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(buf)); } catch { reject(new Error("bad response: " + buf)); } });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res && res.ok ? 0 : 1);
}
main().catch((err) => { console.error(err.message); process.exit(1); });
`;

function writeIfChanged(file, content) {
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (current === content) return;
  fs.writeFileSync(file, content);
}

function installTermCli() {
  try {
    fs.mkdirSync(termBinDir(), { recursive: true });
    // Extensionless script (shebang) works for POSIX shells and Git Bash.
    writeIfChanged(termBinPath(), PI_BG_SOURCE);
    if (process.platform !== "win32") fs.chmodSync(termBinPath(), 0o755);
    if (process.platform === "win32") {
      // cmd.exe resolves through PATHEXT, so ship a .cmd shim. It runs the
      // same JS through the Electron binary as plain Node, so no system
      // Node install is required.
      writeIfChanged(path.join(termBinDir(), "pi-bg.js"), PI_BG_SOURCE);
      const cmd = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "%~dp0pi-bg.js" %*\r\n`;
      writeIfChanged(path.join(termBinDir(), "pi-bg.cmd"), cmd);
    }
  } catch (err) {
    console.error("failed to install pi-bg", err);
  }
}

async function handleTermBridge(payload) {
  try {
    switch (payload.op) {
      case "run": {
        if (typeof payload.command !== "string" || !payload.command.trim()) {
          return { ok: false, error: "command 不能为空" };
        }
        const task = startTask({
          cmd: payload.command,
          cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
          label: typeof payload.label === "string" ? payload.label : undefined,
          host: typeof payload.host === "string" ? payload.host : undefined,
          origin: "agent",
        });
        return { ok: true, id: task.id, label: task.label, cwd: task.cwd, status: task.status };
      }
      case "list":
        return {
          ok: true,
          tasks: [...tasks.values()].map(({ kill, output, ...rest }) => ({
            ...rest,
            outputTail: output.slice(-500),
          })),
        };
      case "output": {
        const task = tasks.get(String(payload.id));
        if (!task) return { ok: false, error: "任务不存在" };
        return { ok: true, status: task.status, exitCode: task.exitCode ?? null, output: task.output };
      }
      case "kill": {
        const task = tasks.get(String(payload.id));
        if (!task) return { ok: false, error: "任务不存在" };
        task.kill?.();
        return { ok: true };
      }
      case "wait": {
        const task = tasks.get(String(payload.id));
        if (!task) return { ok: false, error: "任务不存在" };
        const timeoutMs = Math.min(Math.max(Number(payload.timeoutSeconds ?? 60), 1), 600) * 1000;
        const started = Date.now();
        while (task.status === "running" && Date.now() - started < timeoutMs) {
          await new Promise((r) => setTimeout(r, 250));
        }
        return {
          ok: true,
          status: task.status,
          exitCode: task.exitCode ?? null,
          timedOut: task.status === "running",
          output: task.output.slice(-8000),
        };
      }
      default:
        return { ok: false, error: `未知操作: ${payload.op}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let termServer = null;

function startTermBridge() {
  // A stale socket file blocks listen(); named pipes don't need this.
  if (process.platform !== "win32") {
    try { fs.unlinkSync(termSockPath()); } catch {}
  }
  termServer = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          socket.end(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
          return;
        }
        const reply = await handleTermBridge(payload);
        socket.end(JSON.stringify(reply) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  termServer.on("error", (err) => console.error("term bridge failed", err));
  termServer.listen(termSockPath(), () => {
    // Only the current user should be able to drive the app (POSIX only).
    if (process.platform !== "win32") {
      try { fs.chmodSync(termSockPath(), 0o600); } catch {}
    }
  });
}

// ---------------------------------------------------------------- agents

// pi-subagents ships profiles in its package; projects add their own.
function agentDirs(cwd) {
  const pkg = path.join(config.AGENT_DIR, "npm", "node_modules", "pi-subagents", "agents");
  return [pkg, path.join(cwd ?? os.homedir(), ".pi", "agents")];
}

ipcMain.handle("agents:list", (_e, { cwd } = {}) => {
  const out = [];
  for (const [i, dir] of agentDirs(cwd).entries()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(dir, name);
      let raw = "";
      try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
      const front = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      const field = (key) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
      out.push({
        name: name.replace(/\.md$/, ""),
        path: full,
        scope: i === 0 ? "builtin" : "project",
        description: field("description") ?? "",
        tools: field("tools") ?? "",
        model: field("model") ?? "",
      });
    }
  }
  return out;
});

ipcMain.handle("files:tree", (_e, { cwd, dir = "" }) => {
  const root = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const target = path.resolve(root, dir);
  if (!target.startsWith(root)) return [];
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".pi"))
    .map((e) => ({ name: e.name, path: path.posix.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, 500);
});

// Preview only: refuse anything outside the workspace or over 1 MB.
ipcMain.handle("files:read", (_e, { cwd, file }) => {
  const root = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const target = path.resolve(root, file);
  if (!target.startsWith(root)) return { error: "越界路径" };
  try {
    const stat = fs.statSync(target);
    if (stat.size > 1_000_000) return { error: "文件过大" };
    return { content: fs.readFileSync(target, "utf8"), size: stat.size };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(() => {
  // The bridge and its CLI must exist before pi starts, since pi's bash tool
  // uses the injected PATH / env to reach them.
  installTermCli();
  startTermBridge();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopPi();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopPi();
  try { termServer?.close(); } catch {}
});
