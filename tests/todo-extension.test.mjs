// 单测 TodoWrite 扩展：用 jiti 直接加载 TS 源码（与 pi 运行时同一条加载路径），
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

const listOf = (todos) => ({ todos });

test("TodoWrite：全量列表替换 + 状态与 widget 行", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("TodoWrite");
  assert.ok(tool, "TodoWrite 工具已注册");
  assert.equal(pi.tools.has("todo"), false, "旧的增量 todo 工具不再注册");

  const ctx = makeCtx();
  const first = await tool.execute(
    "c1",
    listOf([
      { content: "读代码", status: "completed" },
      { content: "改实现", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]),
    null,
    null,
    ctx,
  );
  assert.equal(first.details.todos.length, 3);
  assert.equal(first.details.todos[0].done, true);
  assert.match(first.content[0].text, /1\/3 completed/);

  const paint = ctx.calls.at(-1);
  assert.equal(paint.key, "todo");
  assert.ok(Array.isArray(paint.lines), "必须是字符串数组（RPC 模式唯一支持）");
  assert.match(paint.lines[0], /Todo 1\/3/);
  assert.ok(paint.lines.some((l) => l.startsWith("✓") && l.includes("读代码")));
  assert.ok(paint.lines.some((l) => l.startsWith("▸") && l.includes("改实现")));

  // 第二次调用只带新列表 → 整份替换（不是追加）
  const second = await tool.execute(
    "c2",
    listOf([{ content: "跑测试", status: "completed" }]),
    null,
    null,
    ctx,
  );
  assert.equal(second.details.todos.length, 1);
  assert.match(ctx.calls.at(-1).lines[0], /Todo 1\/1/);

  // 空列表 → 移除卡片
  await tool.execute("c3", listOf([]), null, null, ctx);
  assert.equal(ctx.calls.at(-1).lines, undefined);
});

test("TodoWrite：session_tree 从分支 details 重建（新旧两代格式）", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);

  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "TodoWrite",
        details: {
          action: "set",
          todos: [
            { content: "甲", status: "completed" },
            { content: "乙", status: "in_progress" },
          ],
          nextId: 3,
        },
      },
    },
  ];
  const ctx = makeCtx(branch);
  const handler = pi.handlers.get("session_tree");
  assert.ok(handler, "注册了 session_tree");
  await handler({}, ctx);
  const paint = ctx.calls.at(-1);
  assert.match(paint.lines[0], /Todo 1\/2/, "从分支恢复出 1/2 完成");
  assert.ok(paint.lines.some((l) => l.includes("乙")));

  // 旧会话的增量格式（toolName=todo + done 布尔）也要能读
  const legacy = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          action: "toggle",
          todos: [
            { id: 1, text: "旧甲", done: true },
            { id: 2, text: "旧乙", done: false },
          ],
          nextId: 3,
        },
      },
    },
  ];
  const ctx2 = makeCtx(legacy);
  await handler({}, ctx2);
  assert.match(ctx2.calls.at(-1).lines[0], /Todo 1\/2/, "旧格式重建出 1/2");
});

test("TodoWrite：agent_start 撤下上一回合完成的项，全部完成时移除卡片", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("TodoWrite");
  const ctx = makeCtx();

  await tool.execute(
    "c1",
    listOf([
      { content: "甲", status: "completed" },
      { content: "乙", status: "pending" },
    ]),
    null,
    null,
    ctx,
  );
  let lines = ctx.calls.at(-1).lines;
  assert.ok(lines.some((l) => l.startsWith("✓") && l.includes("甲")), "本回合内完成的项仍然显示");

  // 下一回合开始：已完成的甲从面板撤掉，只剩乙（进度仍是 1/2）
  await pi.handlers.get("agent_start")({}, ctx);
  lines = ctx.calls.at(-1).lines;
  assert.match(lines[0], /Todo 1\/2/);
  assert.ok(!lines.some((l) => l.includes("甲")), "上一回合完成的项被撤下");
  assert.ok(lines.some((l) => l.startsWith("▸") && l.includes("乙")));

  // 全部完成 → 下一回合开始直接移除卡片
  await tool.execute(
    "c2",
    listOf([
      { content: "甲", status: "completed" },
      { content: "乙", status: "completed" },
    ]),
    null,
    null,
    ctx,
  );
  await pi.handlers.get("agent_start")({}, ctx);
  assert.equal(ctx.calls.at(-1).lines, undefined, "全部完成且已撤下时移除卡片");
});

test("TodoWrite：agent_before_settle 提醒未完成项 + 同批防循环", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const tool = pi.tools.get("TodoWrite");
  const ctx = makeCtx();
  const settle = () => pi.handlers.get("agent_before_settle")({ entries: [] }, ctx);
  const reminderOf = (res) => res?.entries?.find((e) => e.type === "custom_message")?.content ?? "";

  // 无清单：不提醒
  assert.equal(await settle(), undefined);

  await tool.execute(
    "c1",
    listOf([{ content: "Stage A", status: "pending" }]),
    null,
    null,
    ctx,
  );
  const nudged = await settle();
  assert.equal(nudged.continue, true);
  assert.match(reminderOf(nudged), /Stage A/);
  assert.match(reminderOf(nudged), /TodoWrite/);

  // 同一批不再重复提醒
  assert.equal(await settle(), undefined);

  // 新的一次用户输入（input 事件）后允许再提醒一次
  await pi.handlers.get("input")({}, ctx);
  const nudgedAgain = await settle();
  assert.equal(nudgedAgain.continue, true);

  // 全部完成：不提醒
  await tool.execute(
    "c2",
    listOf([{ content: "Stage A", status: "completed" }]),
    null,
    null,
    ctx,
  );
  assert.equal(await settle(), undefined);
});

test("TodoWrite：连续多轮干活却没用清单时按回合边界提醒", async () => {
  const factory = await loadTodoExtension();
  const pi = makePi();
  factory(pi);
  const ctx = makeCtx();
  const turnEnd = () => pi.handlers.get("turn_end")({ entries: [], toolResults: [{ ok: true }] }, ctx);
  const reminderOf = (res) => res?.entries?.find((e) => e.type === "custom_message")?.content ?? "";

  // 前 5 轮不提醒
  for (let i = 0; i < 5; i++) assert.equal(await turnEnd(), undefined);

  // 第 6 轮（已跑 6 轮工具）→ 提醒建清单，并请求继续
  const nudged = await turnEnd();
  assert.equal(nudged.continue, true);
  assert.match(reminderOf(nudged), /TodoWrite/);
  assert.match(reminderOf(nudged), /3 个以上步骤/);

  // 提醒后立刻的回合不再重复
  assert.equal(await turnEnd(), undefined);

  // 写一次清单后计数清零：连续 5 轮又不提醒
  await pi.tools.get("TodoWrite").execute(
    "c1",
    listOf([{ content: "甲", status: "in_progress" }]),
    null,
    null,
    ctx,
  );
  for (let i = 0; i < 5; i++) assert.equal(await turnEnd(), undefined);

  // 再第 6 轮：已有清单 → 提醒更新（而不是"建清单"）
  const nudged2 = await turnEnd();
  assert.match(reminderOf(nudged2), /更新清单/);
  assert.match(reminderOf(nudged2), /in_progress 甲/);
});
