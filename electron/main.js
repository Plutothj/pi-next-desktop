// Electron main process: owns the `pi --mode rpc` child process and bridges
// its JSONL protocol to the renderer over IPC.

import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "./config.js";

// ---------------------------------------------------------------- runtime

// Electron ships a Node runtime that can be reused as a plain interpreter.
const ELECTRON_AS_NODE = { node: process.execPath, args: [], asNode: true };

function whichSync(bin) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
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

function startPi(cwd) {
  stopPi();
  const rt = resolveRuntime();
  child = spawn(rt.node, [rt.cli, "--mode", "rpc"], {
    cwd,
    env: {
      ...process.env,
      ...rt.env,
      PATH: `${path.dirname(rt.node)}:${process.env.PATH ?? ""}`,
      ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Split strictly on LF. Node's readline also splits on U+2028/U+2029, which
  // are legal inside JSON strings.
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
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

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(d));

  child.on("exit", (code, signal) => {
    child = null;
    for (const { reject } of pending.values()) reject(new Error("pi exited"));
    pending.clear();
    send({ type: "child_exit", code, signal });
  });
}

function stopPi() {
  if (!child) return;
  try { child.stdin.end(); } catch {}
  const dying = child;
  child = null;
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
  // select / input / editor are not implemented in v1: cancel so pi never hangs.
  if (["select", "input", "editor"].includes(req.method)) {
    send({ type: "ui_notify", message: `不支持的扩展对话框: ${req.method}`, notifyType: "warning" });
    reply({ cancelled: true });
  }
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
    // Only tool-call records can change files; skip JSON.parse for everything else.
    if (index > 0 && !line.includes('"toolCall"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "session" && !header) header = rec;
    if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
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
    if (rec.type === "session_info" && rec.name) title = rec.name;
    if (!title && rec.type === "message" && rec.message?.role === "user") {
      const c = rec.message.content;
      const text = typeof c === "string" ? c : c?.find((b) => b.type === "text")?.text;
      if (text) title = text.replace(/\s+/g, " ").slice(0, 80);
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

ipcMain.handle("pi:sessions", () => {
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
        PATH: `${path.dirname(rt.node)}:${process.env.PATH ?? ""}`,
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
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    scored.push({ file, score: (base.startsWith(q) ? 0 : 100) + idx });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 40).map((s) => s.file);
});

// ---------------------------------------------------------------- tasks
// Long commands run detached from pi's RPC turn so the agent can keep going.
// Plain pipes, not a PTY: interactive full-screen programs need node-pty.
const tasks = new Map();
let taskId = 1;
const MAX_OUTPUT = 200_000;

ipcMain.handle("term:run", (_e, { cmd, cwd, label, host }) => {
  const id = String(taskId++);
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = host
    ? ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, cmd]]
    : ["/bin/zsh", ["-lc", cmd]];
  const proc = spawn(shell[0], shell[1], {
    cwd: dir,
    env: { ...process.env, TERM: "dumb", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task = {
    id,
    cmd,
    label: host ? `${host}: ${label ?? cmd.slice(0, 50)}` : label ?? cmd.slice(0, 60),
    cwd: dir,
    host: host ?? null,
    status: "running",
    startedAt: Date.now(),
    exitCode: null,
    output: "",
  };
  tasks.set(id, task);

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
  task.kill = () => { try { proc.kill("SIGTERM"); } catch {} };
  return { id, cwd: dir };
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopPi();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopPi);
