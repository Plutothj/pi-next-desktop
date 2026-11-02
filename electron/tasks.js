// Background tasks: long commands run detached from pi's RPC turn.
// The UI and the agent (via the pi-bg CLI over a local bridge) share one table.
// Plain pipes, not a PTY: interactive full-screen programs need node-pty.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { logLine } from "./logs.js";

export function termPaths(userDataDir) {
  // Node speaks named pipes with the same net API on Windows, and AF_UNIX is
  // not uniformly available there, so pick the platform-native endpoint.
  const sock =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-desktop-term-${os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "")}`
      : path.join(userDataDir, "term.sock");
  const binDir = path.join(userDataDir, "bin");
  return { sock, binDir, binPath: path.join(binDir, "pi-bg") };
}

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

export function installTermCli(userDataDir) {
  const { binDir, binPath } = termPaths(userDataDir);
  try {
    fs.mkdirSync(binDir, { recursive: true });
    // Extensionless script (shebang) works for POSIX shells and Git Bash.
    writeIfChanged(binPath, PI_BG_SOURCE);
    if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
    if (process.platform === "win32") {
      // cmd.exe resolves through PATHEXT, so ship a .cmd shim. It runs the
      // same JS through the Electron binary as plain Node, so no system
      // Node install is required.
      writeIfChanged(path.join(binDir, "pi-bg.js"), PI_BG_SOURCE);
      const cmd = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "%~dp0pi-bg.js" %*\r\n`;
      writeIfChanged(path.join(binDir, "pi-bg.cmd"), cmd);
    }
  } catch (err) {
    logLine("term-cli", err);
  }
}

const MAX_OUTPUT = 200_000;
const publicTask = ({ kill, output, ...rest }) => ({ ...rest, outputTail: output.slice(-500) });

export function createTaskManager({ userDataDir, send }) {
  const paths = termPaths(userDataDir);
  const tasks = new Map();
  let taskId = 1;

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
        PI_DESKTOP_TERM_SOCK: paths.sock,
        PATH: [paths.binDir, process.env.PATH ?? ""].join(path.delimiter),
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

  async function handleBridge(payload) {
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
          return { ok: true, id: task.id, label: task.label, cwd: task.cwd, status: task.status, origin: task.origin };
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

  let server = null;

  function startBridge() {
    // A stale socket file blocks listen(); named pipes don't need this.
    if (process.platform !== "win32") {
      try { fs.unlinkSync(paths.sock); } catch {}
    }
    server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", async (chunk) => {
        buf += chunk;
        let nl;
        // biome-ignore lint/suspicious/noAssignInExpressions: LF 严格切分是 AGENTS.md 硬性规则的模式
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            socket.end(`${JSON.stringify({ ok: false, error: "invalid json" })}\n`);
            return;
          }
          const reply = await handleBridge(payload);
          socket.end(`${JSON.stringify(reply)}\n`);
        }
      });
      socket.on("error", () => {});
    });
    server.on("error", (err) => {
      logLine("term-bridge", err);
      // 被其他实例占用等场景：不能只写日志让终端面板静默失效
      send?.({
        type: "ui_notify",
        message: `终端桥接启动失败（${err.code ?? "错误"}），本实例的后台任务面板不可用。`,
        notifyType: "warning",
      });
    });
    server.listen(paths.sock, () => {
      // Only the current user should be able to drive the app (POSIX only).
      if (process.platform !== "win32") {
        try { fs.chmodSync(paths.sock, 0o600); } catch {}
      }
    });
  }

  function stopBridge() {
    try { server?.close(); } catch {}
  }

  const listTasks = () => [...tasks.values()].map(({ kill, ...rest }) => rest);

  function killTask(id) {
    tasks.get(id)?.kill?.();
    return { ok: true };
  }

  function removeTask(id) {
    tasks.get(id)?.kill?.();
    tasks.delete(id);
    return { ok: true };
  }

  const snapshot = () => [...tasks.values()].map(({ kill, output, ...rest }) => ({
    ...rest,
    outputTail: output.slice(-300),
  }));

  return { paths, startTask, startBridge, stopBridge, listTasks, killTask, removeTask, snapshot };
}
