// Locating and talking to the pi runtime: node/cli resolution, version,
// capability probing, and the JSONL RPC child process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Electron ships a Node runtime that can be reused as a plain interpreter.
const ELECTRON_AS_NODE = { node: process.execPath, args: [], asNode: true };

export function whichSync(bin) {
  // Windows resolves executables through PATHEXT (exe/cmd/bat), not X_OK.
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
export function resolveRuntime() {
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

/** Best-effort pi version, for diagnostics and compatibility notes. */
export function runtimeVersion(rt) {
  try {
    if (rt.installRoot) {
      return fs.readFileSync(path.join(rt.installRoot, "current-version"), "utf8").trim();
    }
    const versionFile = path.join(path.dirname(rt.cli), "VERSION");
    if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, "utf8").trim();
  } catch {}
  return "unknown";
}

// The agent needs to know that long-running commands belong to the desktop's
// task panel. Scoped to sessions this app spawns (--append-system-prompt).
export const PI_BG_INSTRUCTIONS =
  "Background tasks: this session runs inside the Pi Desktop app, which has a terminal panel for " +
  "long-running processes. Do not run dev servers, watchers, or long builds synchronously in bash. " +
  'Start them with `pi-bg "<command>"` (options: --cwd DIR, --label TEXT); it returns a task id. ' +
  "Check with `pi-bg --list` or `pi-bg --output <id>`, block with `pi-bg --wait <id>`, stop with " +
  "`pi-bg --kill <id>`. The task keeps running after your turn and appears in the user's UI. " +
  "Keep ordinary short commands in the normal bash tool.";

// Ask the CLI itself whether it knows the flag (help text lists it). Cached per
// CLI path so a pi upgrade is picked up after an app restart.
const appendPromptSupport = new Map();

export function supportsAppendPrompt(rt) {
  const cached = appendPromptSupport.get(rt.cli);
  if (cached) return cached;
  const probe = new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const proc = spawn(rt.node, [rt.cli, "--help"], {
      env: { ...process.env, ...rt.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      // Unknown either way: prefer trying the flag.
      done(true);
    }, 5000);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("error", () => done(true));
    proc.on("exit", () => done(out.includes("append-system-prompt")));
  });
  appendPromptSupport.set(rt.cli, probe);
  return probe;
}

/** One `pi --mode rpc` child, with request/response correlation. */
export class PiProcess {
  constructor({ onRecord, onExit, onStderr } = {}) {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onRecord = onRecord ?? (() => {});
    this.onExit = onExit ?? (() => {});
    this.onStderr = onStderr ?? (() => {});
  }

  get running() {
    return Boolean(this.child);
  }

  write(record) {
    if (!this.child) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(record)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  start({ node, argv, cwd, env }) {
    this.stop();
    // Keep a local reference: the old process's exit handler must never touch
    // the new one during a restart.
    const proc = spawn(node, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = proc;

    // Split strictly on LF. Node's readline also splits on U+2028/U+2029,
    // which are legal inside JSON strings.
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
        this.handleRecord(line);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => this.onStderr(d));

    proc.on("exit", (code, signal) => {
      // A superseded process exiting during a restart is not news.
      if (this.child !== proc) return;
      this.child = null;
      for (const { reject } of this.pending.values()) reject(new Error("pi exited"));
      this.pending.clear();
      this.onExit({ code, signal });
    });
    return proc;
  }

  stop() {
    if (!this.child) return;
    const dying = this.child;
    this.child = null;
    try { dying.stdin.end(); } catch {}
    // Commands aimed at the old process will never be answered.
    for (const { reject } of this.pending.values()) reject(new Error("pi 重启中"));
    this.pending.clear();
    setTimeout(() => { try { dying.kill("SIGKILL"); } catch {} }, 1500);
  }

  handleRecord(line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      this.onRecord({ type: "client_error", message: `无法解析 pi 输出: ${line.slice(0, 200)}` });
      return;
    }
    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const { resolve, reject } = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      rec.success ? resolve(rec) : reject(new Error(rec.error || "command failed"));
      return;
    }
    this.onRecord(rec);
  }

  command(payload) {
    if (!this.child) return Promise.reject(new Error("pi 未运行"));
    const id = String(this.nextId++);
    const record = { id, ...payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify(record)}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}
