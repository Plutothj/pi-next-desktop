// Smoke tests for the background-task manager and its local bridge
// (Unix socket / named pipe). Spawns real short-lived shell commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTaskManager, installTermCli } from "../electron/tasks.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-"));
const send = () => {};
// 独立命名管道：不与正在运行的正式实例互抢（Windows 上必须是 pipe 路径）
const manager = createTaskManager({
  userDataDir: tmp,
  send,
  sock: `\\\\.\\pipe\\pi-desktop-term-test-${process.pid}`,
});

function waitFor(manager, id, status = "done", timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const task = manager.listTasks().find((t) => t.id === id);
      if (task && task.status === status) return resolve(task);
      if (task && task.status === "failed" && status === "done") {
        return reject(new Error(`task failed: ${task.output?.slice(-200)}`));
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function bridgeRequest(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (d) => { buf += d.toString(); });
    socket.on("end", () => resolve(JSON.parse(buf)));
    socket.on("error", reject);
  });
}

test("startTask runs a command and captures output", async () => {
  const task = manager.startTask({ cmd: "echo bridge-ok" });
  const done = await waitFor(manager, task.id);
  assert.equal(done.exitCode, 0);
  const listed = manager.listTasks().find((t) => t.id === task.id);
  assert.match(listed.output, /bridge-ok/);
});

test("killTask stops a running command", async () => {
  const task = manager.startTask({ cmd: "sleep 30" });
  await new Promise((r) => setTimeout(r, 300));
  manager.killTask(task.id);
  const done = await waitFor(manager, task.id, "failed");
  assert.equal(done.exitCode === 0, false);
});

test("bridge handles run/list/wait over the socket", async () => {
  manager.startBridge();
  // The socket needs a tick to listen; poll connect until it accepts.
  let res = null;
  for (let i = 0; i < 40 && !res; i++) {
    res = await bridgeRequest(manager.paths.sock, { op: "run", command: "echo ping" }).catch(() => null);
    if (!res) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(res.ok, true);
  assert.equal(res.origin, "agent");
  const done = await waitFor(manager, res.id);
  assert.match(done.output, /ping/);

  const listed = await bridgeRequest(manager.paths.sock, { op: "list" });
  assert.equal(listed.ok, true);
  assert.ok(listed.tasks.some((t) => t.id === res.id));

  const waited = await bridgeRequest(manager.paths.sock, { op: "wait", id: res.id, timeoutSeconds: 5 });
  assert.equal(waited.ok, true);
  assert.equal(waited.status, "done");
  assert.match(waited.output, /ping/);
  manager.stopBridge();
});

test("pi-bg defaults the task cwd to the caller's cwd", async () => {
  // 回归：agent 从会话目录跑 pi-bg 且不带 --cwd 时，任务曾落到主进程 cwd
  // （快捷方式启动即 C:\Users\EDY）。pi-bg 必须默认自己的 process.cwd()。
  const cliDir = path.join(tmp, "cli");
  installTermCli(cliDir);
  const piBgJs = path.join(cliDir, "bin", "pi-bg.js");
  assert.ok(fs.existsSync(piBgJs), "pi-bg.js 未生成");

  manager.startBridge();
  // 桥监听就绪前 pi-bg 会连接失败，先探活（同上面 run/list/wait 的做法）
  let ready = null;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await bridgeRequest(manager.paths.sock, { op: "list" }).catch(() => null);
    if (!ready) await sleep(100);
  }
  assert.ok(ready, "桥未就绪");

  const runDir = path.join(tmp, "rundir");
  fs.mkdirSync(runDir, { recursive: true });

  const piBgDone = new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [piBgJs, "echo", "cwd-test"],
      {
        cwd: runDir,
        env: { ...process.env, PI_DESKTOP_TERM_SOCK: manager.paths.sock },
      },
    );
    child.on("exit", (code) => resolve(code));
  });

  // pi-bg 会阻塞到任务完成才退出；轮询等新任务出现（列表里有旧测试的任务）
  let task = null;
  for (let i = 0; i < 40 && !task; i++) {
    await sleep(150);
    const listed = await bridgeRequest(manager.paths.sock, { op: "list" }).catch(() => null);
    task = listed?.tasks?.find((t) => t.cmd?.includes("cwd-test")) ?? null;
  }
  assert.ok(task, "任务已创建");
  assert.equal(task.cwd, runDir, "任务 cwd 必须是 pi-bg 调用方目录，而不是主进程/主目录");
  manager.stopBridge();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
