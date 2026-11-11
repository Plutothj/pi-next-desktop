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

test("FTS5 全文搜索与会话视图缓存", async () => {
  const dir = path.join(process.env.PI_AGENT_DIR, "sessions", "--tmp-search--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "search.jsonl");
  const lines = [
    header(),
    user("请帮我排查登录页面的白屏问题"),
    JSON.stringify({
      type: "message",
      id: uuid(),
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "白屏是因为渲染进程里 contextUsage 为空时崩溃了。" }] },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);

  const {
    scanSessionsIndexed,
    searchSessionsIndexed,
    readSessionView,
    writeSessionView,
    closeSessionIndex,
  } = await import("../electron/session-index.js");

  await scanSessionsIndexed();
  const found = await searchSessionsIndexed("白屏");
  assert.ok(found.hits.length >= 1, JSON.stringify(found));
  assert.equal(found.hits[0].path, file);
  assert.match(found.hits[0].snippet, /白屏/);

  // 追加新内容 → 再次扫描后能搜到新词
  fs.appendFileSync(file, `${user("后来又发现导出功能也挂了")}\n`);
  await scanSessionsIndexed();
  const found2 = await searchSessionsIndexed("导出");
  assert.ok(found2.hits.some((h) => h.path === file), JSON.stringify(found2));

  // 视图缓存：只保留尾部 120 条；图片 data 被清空
  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `消息 ${i}` }],
  }));
  messages.push({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] });
  writeSessionView(file, messages);
  const view = readSessionView(file);
  assert.ok(view, "视图缓存应可读");
  assert.equal(view.messages.length, 120);
  const image = view.messages.at(-1).content[0];
  assert.equal(image.type, "image");
  assert.equal(image.data, "");

  // 冷启动后仍能读
  closeSessionIndex();
  await scanSessionsIndexed();
  const afterCold = readSessionView(file);
  assert.ok(afterCold, "冷启动后视图缓存仍在");
  const coldSearch = await searchSessionsIndexed("白屏");
  assert.ok(coldSearch.hits.length >= 1);
});
