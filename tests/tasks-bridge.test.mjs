// Smoke tests for the background-task manager and its local bridge
// (Unix socket / named pipe). Spawns real short-lived shell commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "../electron/tasks.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-"));
const send = () => {};
const manager = createTaskManager({ userDataDir: tmp, send });

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
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
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
