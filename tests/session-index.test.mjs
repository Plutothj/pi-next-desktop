// SQLite 会话元数据索引：冷/热扫描一致、文件变更重解析、删除 prune。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-index-test-"));
process.env.PI_AGENT_DIR = path.join(root, "agent");
process.env.PI_DESKTOP_HOME = path.join(root, "home");

const uuid = () => crypto.randomUUID();
function makeSession(tag, lines) {
  const dir = path.join(process.env.PI_AGENT_DIR, "sessions", `--tmp-proj--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tag}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const header = () =>
  JSON.stringify({ type: "session", version: 3, id: uuid(), timestamp: "t", cwd: "/tmp/proj" });
const user = (text) =>
  JSON.stringify({
    type: "message",
    id: uuid(),
    parentId: null,
    timestamp: "t",
    message: { role: "user", content: [{ type: "text", text }] },
  });

test("scanSessionsIndexed：写入索引、热扫描命中、变更重解析、删除 prune", async () => {
  const one = makeSession("one", [header(), user("第一个会话")]);
  const two = makeSession("two", [header(), user("第二个会话")]);

  const { scanSessionsIndexed, closeSessionIndex, SESSION_INDEX_FILE } = await import(
    "../electron/session-index.js"
  );

  const first = await scanSessionsIndexed();
  assert.equal(first.length, 2);
  const titles = first.map((s) => s.title).sort();
  assert.deepEqual(titles, ["第一个会话", "第二个会话"]);
  assert.ok(fs.existsSync(SESSION_INDEX_FILE), "索引库已落盘");

  // 冷启动（关连接重开）仍然只靠索引拿到同样的数据
  closeSessionIndex();
  const second = await scanSessionsIndexed();
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((s) => s.title).sort(), titles);

  // 文件变了（追加 session_info 重命名）→ 重新解析
  fs.appendFileSync(
    one,
    `${JSON.stringify({ type: "session_info", id: uuid(), parentId: null, name: "改名后" })}\n`,
  );
  const third = await scanSessionsIndexed();
  assert.ok(third.some((s) => s.title === "改名后"), JSON.stringify(third.map((s) => s.title)));

  // 删除文件 → 索引 prune
  fs.rmSync(two);
  const fourth = await scanSessionsIndexed();
  assert.equal(fourth.length, 1);
  assert.equal(fourth[0].title, "改名后");
});
