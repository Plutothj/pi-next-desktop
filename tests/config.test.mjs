// config.js 纯函数单测：providers / prompts 的读写往返、守卫与去重。
// AGENT_DIR 由环境变量指向临时目录，必须在 import 之前设置。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));

const config = await import("../electron/config.js");
const { saveProvider, listProviders, savePrompt, readPrompt, deletePrompt, listPrompts, deleteSkill } =
  config;

test("saveProvider/listProviders 往返保留 headers 与模型元数据", () => {
  saveProvider({
    name: "relay",
    displayName: "中转站",
    api: "openai-completions",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-secret-abc123",
    headers: { "X-Api-Key": "$RELAY_KEY", "User-Agent": "pi-desktop/0.2" },
    models: [
      {
        id: "m1",
        name: "Model One",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1048576,
        maxTokens: 393216,
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      },
      { id: "m1", name: "duplicate ignored" },
      { id: "", name: "no id dropped" },
    ],
  });

  const info = listProviders().find((p) => p.name === "relay");
  assert.equal(info.hasKey, true);
  // 密钥内容（含掩码片段）永远不回传渲染层
  assert.equal(info.keyHint, null);
  assert.ok(!JSON.stringify(info).includes("sk-secret"));
  assert.deepEqual(info.headers, { "X-Api-Key": "$RELAY_KEY", "User-Agent": "pi-desktop/0.2" });
  assert.equal(info.models.length, 1, "重复 id 与空 id 被过滤");
  assert.equal(info.models[0].contextWindow, 1048576);
  assert.equal(info.models[0].maxTokens, 393216);
  assert.equal(info.models[0].cost.input, 0.15);
  assert.deepEqual(info.models[0].input, ["text", "image"]);
});

test("saveProvider 清空 headers 会删除字段，密钥留空则保留", () => {
  saveProvider({
    name: "relay",
    displayName: "中转站",
    api: "openai-completions",
    baseUrl: "https://relay.example.com/v1",
    headers: {},
    models: [{ id: "m1" }],
  });
  const info = listProviders().find((p) => p.name === "relay");
  assert.equal(info.headers, null);
  assert.equal(info.hasKey, true, "未传 apiKey 时保留已存密钥");
});

test("prompts：保存/读取/列表/删除，含项目级与守卫", () => {
  const cwd = "D:/workspace";
  savePrompt({ scope: "user", name: "review", content: "审查当前改动" });
  savePrompt({ scope: "project", name: "deploy", content: "部署流程", cwd });

  const names = listPrompts(cwd).map((p) => `${p.name}@${p.scope}`);
  assert.ok(names.includes("review@user"));
  assert.ok(names.includes("deploy@project"));

  assert.ok(readPrompt({ scope: "user", name: "review" }).includes("审查当前改动"));
  assert.ok(readPrompt({ scope: "project", name: "deploy", cwd }).includes("部署流程"));

  // 名字白名单挡掉路径穿越与非法字符
  for (const bad of ["../evil", "has space", "a/b"]) {
    assert.throws(() => savePrompt({ scope: "user", name: bad, content: "x" }), /命令名/);
    assert.throws(() => readPrompt({ scope: "user", name: bad, cwd }), /命令名/);
    assert.throws(() => deletePrompt({ scope: "user", name: bad, cwd }), /命令名/);
  }

  deletePrompt({ scope: "user", name: "review" });
  assert.throws(() => readPrompt({ scope: "user", name: "review" }));
  assert.ok(!listPrompts(cwd).some((p) => p.name === "review"));
});

test("deleteSkill 拒绝 skills 目录之外的兄弟路径", () => {
  const evil = path.join(process.env.PI_AGENT_DIR, "skills-evil", "x");
  assert.throws(() => deleteSkill(evil), /只能删除/);
  const ok = path.join(process.env.PI_AGENT_DIR, "skills", "demo");
  fs.mkdirSync(ok, { recursive: true });
  assert.doesNotThrow(() => deleteSkill(ok));
});

test("deleteSkill 允许共享的 ~/.agents/skills（用户的技能多在这里）", () => {
  const dir = path.join(os.homedir(), ".agents", "skills", `pi-config-test-${process.pid}`);
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  try {
    assert.doesNotThrow(() => deleteSkill(path.join(dir, "demo")));
    assert.equal(fs.existsSync(path.join(dir, "demo")), false, "技能目录真的被删掉");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
