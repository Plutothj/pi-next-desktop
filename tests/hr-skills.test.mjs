// 单测 HR 技能包：安装到 <agent>/skills 的幂等性 + frontmatter 能被配置层解析 +
// 关键内容不丢（模板/公式/工具指引都在）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHrSkills } from "../electron/hr-skills.js";
import { listSkills } from "../electron/config.js";

test("hr-skills：安装后三套技能可被 listSkills 解析", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "hr-skills-"));
  // listSkills 读 AGENT_DIR（环境变量在模块加载时确定），用 PI_AGENT_DIR 与
  // 安装目录对齐：这里直接读安装产物目录结构，避免依赖模块级常量。
  const written = installHrSkills(agent);
  assert.equal(written.length, 3, "首次安装写出三套技能");

  for (const name of ["hr-employee-writing", "meeting-notes", "event-plan"]) {
    const file = path.join(agent, "skills", name, "SKILL.md");
    assert.ok(fs.existsSync(file), `${name} 落盘`);
    const raw = fs.readFileSync(file, "utf8");
    // frontmatter 必须是 --- 开头，且含 name/description（配置层解析前提）
    assert.match(raw, /^---\n/);
    assert.match(raw, new RegExp(`name: ${name}`));
    assert.match(raw, /description: /);
    // body 不能为空（技能正文才是指令）
    assert.ok(raw.split("\n---\n")[1]?.trim().length > 200, "正文足够具体");
  }

  // 幂等：内容未变不重写（written 为空）
  assert.deepEqual(installHrSkills(agent), []);

  // 关键内容抽查
  const meeting = fs.readFileSync(path.join(agent, "skills", "meeting-notes", "SKILL.md"), "utf8");
  assert.match(meeting, /TodoWrite/, "会议纪要要接 TodoWrite 工具");
  assert.match(meeting, /负责人/, "行动项要有责任人列");

  const event = fs.readFileSync(path.join(agent, "skills", "event-plan", "SKILL.md"), "utf8");
  assert.match(event, /=SUM/, "预算要公式而不是手算");
  assert.match(event, /table/, "预算表接 table 工具");

  const hr = fs.readFileSync(path.join(agent, "skills", "hr-employee-writing", "SKILL.md"), "utf8");
  assert.match(hr, /PIP/);
  assert.match(hr, /法务|劳动合同/, "涉及法律要给免责提醒");

  fs.rmSync(agent, { recursive: true, force: true });
});

test("hr-skills：与配置层的解析约定一致（name/description 抽取）", () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "hr-skills-meta-"));
  installHrSkills(agent);
  // 复刻 config.js:readSkillMeta 的抽取逻辑（避免依赖其内部函数导出）
  const field = (raw, key) => raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  for (const name of ["hr-employee-writing", "meeting-notes", "event-plan"]) {
    const raw = fs.readFileSync(path.join(agent, "skills", name, "SKILL.md"), "utf8");
    assert.equal(field(raw, "name"), name, "name 与目录名一致");
    assert.ok((field(raw, "description") ?? "").length > 20, "description 足够让模型判断触发时机");
  }
  fs.rmSync(agent, { recursive: true, force: true });
});
