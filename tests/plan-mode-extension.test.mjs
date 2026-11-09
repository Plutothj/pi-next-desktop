// 单测 plan-mode 扩展：jiti 加载真实 TS 源码（与 pi 同一条路径），断言
// Enter/Exit 工具、只读闸门、拒绝反馈与 plan 文档落盘。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { installPlanModeExtension } from "../electron/plan-mode-extension.js";

const runtimeModules = path.join(import.meta.dirname, "..", "runtime", "node_modules");

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

function makeCtx({ sessionFile, cwd, confirmResult = true, feedback = "" }) {
  const calls = [];
  return {
    cwd,
    calls,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "sess-1",
      getCwd: () => cwd,
    },
    ui: {
      setStatus(key, text) {
        calls.push({ kind: "status", key, text });
      },
      async confirm(title, message) {
        calls.push({ kind: "confirm", title, message });
        return confirmResult;
      },
      async editor(title, prefill) {
        calls.push({ kind: "editor", title, prefill });
        return feedback;
      },
    },
  };
}

async function loadExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-unit-"));
  const file = installPlanModeExtension(dir);
  // typebox 由 runtime 提供；jiti 从扩展目录解析时需要它在 node_modules 下
  const tb = path.join(runtimeModules, "typebox");
  if (fs.existsSync(tb)) fs.cpSync(tb, path.join(dir, "node_modules", "typebox"), { recursive: true });
  const require = createRequire(path.join(dir, "noop.cjs"));
  const jiti = require(path.join(runtimeModules, "jiti"));
  const createJiti = jiti.default ?? jiti;
  const loader = createJiti(path.join(dir, "noop.cjs"), { interopDefault: true });
  const mod = loader(file);
  return { factory: mod.default ?? mod, dir };
}

test("plan-mode 扩展：进入/拦截/批准落盘/拒绝反馈", async () => {
  const { factory, dir } = await loadExtension();
  const pi = makePi();
  factory(pi);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cwd-"));
  const sessionFile = path.join(cwd, "session.jsonl");
  const ctx = makeCtx({ sessionFile, cwd });

  const enter = pi.tools.get("EnterPlanMode");
  const exit = pi.tools.get("ExitPlanMode");
  assert.ok(enter && exit, "两个计划工具已注册");
  const gate = pi.handlers.get("tool_call");
  assert.ok(gate, "tool_call 闸门已注册");

  // 进入前：闸门放行写操作
  assert.equal(await gate({ toolName: "write", input: {} }, ctx), undefined);

  await enter.execute("t1", {}, null, null, ctx);
  assert.equal(fs.existsSync(`${sessionFile}.plan-mode.json`), true);
  assert.match(ctx.calls.at(-1).text, /计划模式/);

  // 计划模式：只读工具放行，写工具/shell 被拦截
  assert.equal(await gate({ toolName: "read", input: {} }, ctx), undefined);
  assert.equal(await gate({ toolName: "todo", input: {} }, ctx), undefined);
  assert.equal(await gate({ toolName: "table", input: { action: "read" } }, ctx), undefined);
  const blocked = await gate({ toolName: "write", input: {} }, ctx);
  assert.equal(blocked.block, true);
  const bash = await gate({ toolName: "bash", input: { command: "rm -rf" } }, ctx);
  assert.equal(bash.block, true);

  // 未进入计划模式时 ExitPlanMode 稳定失败
  const ctxOff = makeCtx({ sessionFile: path.join(cwd, "other.jsonl"), cwd });
  const notInPlan = await exit.execute("t2", { plan: "x" }, null, null, ctxOff);
  assert.equal(notInPlan.isError, true);
  assert.match(notInPlan.content[0].text, /plan mode is active/);

  // 拒绝 + 反馈：保持计划模式，错误结果带回反馈
  const rejectCtx = makeCtx({ sessionFile, cwd, confirmResult: false, feedback: "把测试步骤写细一点" });
  const rejected = await exit.execute("t3", { plan: "# 计划\n\n1. 改 A" }, null, null, rejectCtx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /把测试步骤写细一点/);
  assert.equal(fs.existsSync(`${sessionFile}.plan-mode.json`), true);
  const flag = JSON.parse(fs.readFileSync(`${sessionFile}.plan-mode.json`, "utf8"));
  assert.equal(flag.enabled, true);

  // 批准：退出计划模式 + 计划文档落到工作区 .pi/plans
  const approveCtx = makeCtx({ sessionFile, cwd, confirmResult: true });
  const approved = await exit.execute(
    "t4",
    { plan: "# 计划\n\n1. 改 A\n2. 跑测试" },
    null,
    null,
    approveCtx,
  );
  assert.equal(approved.details.approved, true);
  assert.equal(fs.existsSync(approved.details.planFile), true);
  assert.match(fs.readFileSync(approved.details.planFile, "utf8"), /跑测试/);
  const after = JSON.parse(fs.readFileSync(`${sessionFile}.plan-mode.json`, "utf8"));
  assert.equal(after.enabled, false);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("plan-mode 扩展：系统提示只在计划模式注入", async () => {
  const { factory, dir } = await loadExtension();
  const pi = makePi();
  factory(pi);
  const before = pi.handlers.get("before_agent_start");
  assert.ok(before);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cwd-"));
  const sessionFile = path.join(cwd, "session.jsonl");
  const ctx = makeCtx({ sessionFile, cwd });
  const event = { systemPromptOptions: { sections: {} } };

  await before(event, ctx);
  assert.equal(event.systemPromptOptions.sections["plan_mode"], undefined);

  await pi.tools.get("EnterPlanMode").execute("t1", {}, null, null, ctx);
  await before(event, ctx);
  assert.match(event.systemPromptOptions.sections["plan_mode"], /read-only/);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
