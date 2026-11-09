// 单测 todo 扩展：用 jiti 直接加载 TS 源码（与 pi 运行时同一条加载路径），
// 假 ctx 调用工具，断言状态流转与 setWidget 输出（必须是字符串数组）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { installTodoExtension } from "../electron/todo-extension.js";

const runtimeModules = path.join(import.meta.dirname, "..", "runtime", "node_modules");

// @earendil-works/pi-* 是 pi 运行时提供的包，测试里用桩替代
const STUBS = {
  "@earendil-works/pi-ai": "export const StringEnum = (values) => ({ type: 'string', enum: values });",
};

function makePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
}

function makeCtx(branch = []) {
  const calls = [];
  return {
    calls,
    sessionManager: { getBranch: () => branch },
    ui: {
      setWidget(key, lines, opts) {
        calls.push({ key, lines, opts });
      },
      setStatus() {},
    },
  };
}

async function loadTodoExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-unit-"));
  const file = installTodoExtension(dir);
  // 桩包放进临时 node_modules，让 jiti 能解析 @earendil-works/pi-ai
  for (const [name, source] of Object.entries(STUBS)) {
    const target = path.join(dir, "node_modules", name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    fs.writeFileSync(path.join(target, "index.js"), source);
  }
  // 软链 runtime/node_modules 里的 typebox 供扩展加载
  const tb = path.join(runtimeModules, "typebox");
  if (fs.existsSync(tb)) {
    fs.cpSync(tb, path.join(dir, "node_modules", "typebox"), { recursive: true });
  }

  const require = createRequire(path.join(dir, "noop.cjs"));
  const jiti = require(path.join(runtimeModules, "jiti"));
  const createJiti = jiti.default ?? jiti;
  const loader = createJiti(path.join(dir, "noop.cjs"), { interopDefault: true });
  const mod = loader(file);
  return mod.default ?? mod;
}

test("todo 扩展：add/toggle/list 产出状态与 widget 行", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("todo");
  assert.ok(tool, "todo 工具已注册");

  const ctx = makeCtx();

  const added = await tool.execute("c1", { action: "add", text: "写文档" }, null, null, ctx);
  assert.equal(added.details.todos.length, 1);
  assert.equal(added.details.todos[0].text, "写文档");
  assert.equal(added.details.todos[0].done, false);

  const paint = ctx.calls.at(-1);
  assert.equal(paint.key, "todo");
  assert.ok(Array.isArray(paint.lines), "必须是字符串数组（RPC 模式唯一支持）");
  assert.match(paint.lines[0], /Todo 0\/1/);
  assert.ok(paint.lines.some((l) => l.includes("写文档")));

  await tool.execute("c2", { action: "toggle", id: 1 }, null, null, ctx);
  const after = ctx.calls.at(-1);
  assert.match(after.lines[0], /Todo 1\/1/);
  assert.ok(after.lines.some((l) => l.startsWith("✓")));

  await tool.execute("c3", { action: "clear" }, null, null, ctx);
  assert.equal(ctx.calls.at(-1).lines, undefined, "清空时传 undefined 让面板移除卡片");

  const listed = await tool.execute("c4", { action: "list" }, null, null, ctx);
  assert.match(listed.content[0].text, /清单为空/);
});

test("todo 扩展：agent_start 撤下上一回合完成的项，全部完成时移除卡片", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("todo");
  const ctx = makeCtx();

  await tool.execute("c1", { action: "add", text: "甲" }, null, null, ctx);
  await tool.execute("c2", { action: "add", text: "乙" }, null, null, ctx);
  await tool.execute("c3", { action: "toggle", id: 1 }, null, null, ctx);
  let lines = ctx.calls.at(-1).lines;
  assert.ok(lines.some((l) => l.startsWith("✓") && l.includes("甲")), "本回合内完成的项仍然显示");

  // 下一回合开始：已完成的甲从面板撤掉，只剩乙（进度仍是 1/2）
  await pi.handlers.get("agent_start")({}, ctx);
  lines = ctx.calls.at(-1).lines;
  assert.match(lines[0], /Todo 1\/2/);
  assert.ok(!lines.some((l) => l.includes("甲")), "上一回合完成的项被撤下");
  assert.ok(lines.some((l) => l.startsWith("▸") && l.includes("乙")));

  // 全部完成 → 下一回合开始直接移除卡片（不是留一张空的）
  await tool.execute("c4", { action: "toggle", id: 2 }, null, null, ctx);
  await pi.handlers.get("agent_start")({}, ctx);
  assert.equal(ctx.calls.at(-1).lines, undefined, "全部完成且已撤下时移除卡片");
});

test("todo 扩展：session_tree 从分支 details 重建状态", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);

  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          action: "add",
          todos: [
            { id: 1, text: "甲", done: true },
            { id: 2, text: "乙", done: false },
          ],
          nextId: 3,
        },
      },
    },
  ];
  const ctx = makeCtx(branch);

  // 触发 session_tree 处理器
  const handler = pi.handlers.get("session_tree");
  assert.ok(handler, "注册了 session_tree");
  await handler({}, ctx);

  const paint = ctx.calls.at(-1);
  assert.ok(paint, "重建后应重绘 widget");
  assert.match(paint.lines[0], /Todo 1\/2/, "从分支恢复出 1/2 完成");
  assert.ok(paint.lines.some((l) => l.startsWith("✓") && l.includes("甲")));
  assert.ok(paint.lines.some((l) => l.startsWith("▸") && l.includes("乙")));

  // 新 id 接着重建的 nextId 走
  const added = await pi.tools.get("todo").execute("c1", { action: "add", text: "丙" }, null, null, ctx);
  assert.equal(added.details.todos.at(-1).id, 3);
});

test("todo 扩展：agent_before_settle 注入提醒 + 同批防循环", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("todo");
  const ctx = makeCtx();
  // pi 的 actionable boundary：返回 entries（custom_message）+ continue 才会
  // 真的多跑一次模型请求；turn_end 里 sendUserMessage 会被"回合仍在跑"拒掉。
  const settle = () => pi.handlers.get("agent_before_settle")({ entries: [] }, ctx);
  const reminderOf = (res) =>
    res?.entries?.find((e) => e.type === "custom_message")?.content ?? "";

  // 无清单：不提醒
  assert.equal(await settle(), undefined);

  // 添加一项 → 结算边界提醒一次（内容点名未完成项），并请求继续
  await tool.execute("c1", { action: "add", text: "Stage A" }, null, null, ctx);
  const nudged = await settle();
  assert.equal(nudged.continue, true);
  assert.match(reminderOf(nudged), /#1 Stage A/);
  assert.match(reminderOf(nudged), /toggle/);

  // 模型无动于衷再次结算：同一批不再重复提醒
  assert.equal(await settle(), undefined);

  // 新一轮用户输入（input 事件）后允许再提醒一次
  await pi.handlers.get("input")({}, ctx);
  const nudgedAgain = await settle();
  assert.equal(nudgedAgain.continue, true);
  assert.match(reminderOf(nudgedAgain), /#1 Stage A/);

  // toggle 完成后：无未完成项不提醒
  await tool.execute("c2", { action: "toggle", id: 1 }, null, null, ctx);
  assert.equal(await settle(), undefined);

  // 新的未完成状态（签名变化）可再次提醒
  await tool.execute("c3", { action: "add", text: "Stage B" }, null, null, ctx);
  const nudged2 = await settle();
  assert.equal(nudged2.continue, true);
  assert.match(reminderOf(nudged2), /#2 Stage B/);

  // clear 后重建：nextId 不回卷，同文案新项的提醒签名不冲突
  await tool.execute("c4", { action: "clear" }, null, null, ctx);
  assert.equal(await settle(), undefined, "清空后重置签名，不再提醒");
  await tool.execute("c5", { action: "add", text: "Stage B" }, null, null, ctx);
  const nudged3 = await settle();
  assert.match(reminderOf(nudged3), /#3 Stage B/);
});
