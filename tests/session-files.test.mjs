// Smoke tests for the pure session-file logic (no Electron required).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildForkLines, scanSessions, sessionTitle } from "../electron/session-files.js";

const uuid = () => crypto.randomUUID();

function makeSession(dir, lines) {
  const file = path.join(dir, `${uuid()}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("sessionTitle falls back to the first user message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
  const file = makeSession(dir, [
    JSON.stringify({ type: "session", version: 3, id: uuid(), timestamp: "t", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "model_change", id: uuid(), parentId: null }),
    JSON.stringify({
      type: "message", id: uuid(), parentId: null,
      message: { role: "user", content: [{ type: "text", text: "帮我 修复\n登录 bug" }] },
    }),
  ]);
  const info = sessionTitle(file);
  assert.equal(info.title, "帮我 修复 登录 bug");
  assert.equal(info.cwd, "/tmp/proj");
  assert.equal(info.version, 3);
  assert.deepEqual(info.changed, { added: 0, removed: 0 });
});

test("sessionTitle: the last session_info rename wins and tool calls count lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
  const file = makeSession(dir, [
    JSON.stringify({ type: "session", version: 3, id: uuid(), timestamp: "t", cwd: "/tmp/proj" }),
    JSON.stringify({
      type: "message", id: uuid(), parentId: null,
      message: { role: "user", content: [{ type: "text", text: "first prompt" }] },
    }),
    JSON.stringify({
      type: "message", id: uuid(), parentId: null,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "write", arguments: { content: "a\nb\nc" } },
          { type: "toolCall", id: "t2", name: "edit", arguments: { edits: [{ oldText: "x\ny", newText: "z" }] } },
        ],
      },
    }),
    JSON.stringify({ type: "session_info", id: uuid(), parentId: null, name: "旧名字" }),
    JSON.stringify({ type: "session_info", id: uuid(), parentId: null, name: "新名字" }),
  ]);
  const info = sessionTitle(file);
  assert.equal(info.title, "新名字");
  assert.deepEqual(info.changed, { added: 4, removed: 2 });
});

test("scanSessions lists and sorts by mtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-root-"));
  const dir = path.join(root, "--tmp-proj--");
  fs.mkdirSync(dir, { recursive: true });
  const old = makeSession(dir, [
    JSON.stringify({ type: "session", version: 3, id: uuid(), timestamp: "t", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "message", id: uuid(), parentId: null, message: { role: "user", content: "old" } }),
  ]);
  const _newer = makeSession(dir, [
    JSON.stringify({ type: "session", version: 3, id: uuid(), timestamp: "t", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "message", id: uuid(), parentId: null, message: { role: "user", content: "newer" } }),
  ]);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(old, past, past);
  const list = scanSessions(root);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "newer");
});

test("buildForkLines guards unknown session versions", () => {
  assert.throws(() => buildForkLines({ type: "session", version: 4, id: "x" }, []), /超出当前支持/);
});

test("buildForkLines writes a v3 header with parentSession and the chain", () => {
  const chain = [
    { type: "message", id: "e1", parentId: null },
    { type: "message", id: "e2", parentId: "e1" },
  ];
  const { newId, lines } = buildForkLines(
    { type: "session", version: 3, id: "src-1", cwd: "/tmp/proj" },
    chain,
  );
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].type, "session");
  assert.equal(parsed[0].version, 3);
  assert.equal(parsed[0].parentSession, "src-1");
  assert.equal(parsed[0].id, newId);
  assert.deepEqual(parsed.slice(1), chain);
});
