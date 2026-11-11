// 展示层剥离：附件解析正文只给模型，用户气泡/队列/标题只留用户原文。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const runtimeModules = path.join(import.meta.dirname, "..", "runtime", "node_modules");
const require = createRequire(path.join(import.meta.dirname, "noop.cjs"));
const jiti = require(path.join(runtimeModules, "jiti"));
const createJiti = jiti.default ?? jiti;
const loader = createJiti(path.join(import.meta.dirname, "noop.cjs"), { interopDefault: true });
const { stripAttachmentBlocks, stripSkillBlock } = loader(
  path.join(import.meta.dirname, "..", "src", "lib", "promptPrefixes.ts"),
);

test("stripAttachmentBlocks 剥掉 docx/pdf 正文块，只留用户原文", () => {
  const raw =
    "看下文档 先把白膜接入\n\n" +
    '<attachment name="白膜视频生成使用接入指引.docx">\n（docx 提取的纯文本，格式信息未保留）\n' +
    "白膜视频生成：功能介绍……\n</attachment>";
  assert.equal(stripAttachmentBlocks(raw), "看下文档 先把白膜接入");
});

test("stripAttachmentBlocks 处理未解析/超限标记与多附件", () => {
  const raw =
    "看看这些\n\n【附件 a.zip：二进制文件，暂不支持解析】\n\n" +
    '<attachment name="b.pdf">\n（PDF 提取的纯文本，版式与图片未保留）\n正文\n</attachment>\n\n' +
    '<attachment name="c.md">\n正文2\n</attachment>';
  assert.equal(stripAttachmentBlocks(raw), "看看这些");
});

test("stripAttachmentBlocks 不误删普通文本里的尖括号/【附件】之外的内容", () => {
  const raw = "diff <a> 和 【说明】都保留";
  assert.equal(stripAttachmentBlocks(raw), raw);
});


test("stripSkillBlock 剥掉 pi 展开的 SKILL.md 正文，只留参数和技能名", () => {
  const raw =
    '<skill name="meeting-notes" location="/home/u/.agents/skills/meeting-notes/SKILL.md"> References are relative to /home/u/.agents/skills/meeting-notes. 会议纪要的完整正文 </skill>  整理这份纪要';
  const out = stripSkillBlock(raw);
  assert.equal(out.name, "meeting-notes");
  assert.equal(out.text, "整理这份纪要");
});

test("stripSkillBlock 不误伤普通文本", () => {
  const raw = "讨论 <skill> 标签的写法";
  const out = stripSkillBlock(raw);
  assert.equal(out.name, null);
  assert.equal(out.text, raw);
});
