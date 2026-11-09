// 计划模式 / 双模型链的指令前缀。pi RPC 的 prompt 没有隐藏注入通道，
// 这些约束必然进入会话记录；渲染层用 stripDirective 把它们从展示中剥离，
// 换成阶段徽章，避免话术污染用户消息。

export const PLAN_PREFIX =
  "只做分析与方案：不要修改文件、不要执行写操作命令，给出分步骤方案后停下等我确认。\n\n";

export const DUAL_PLAN_PREFIX =
  "【规划阶段】只做分析与方案：不要修改任何文件，也不要执行会改变状态的命令。请给出分步骤实施方案，具体到要改的文件/函数/命令，并说明每步如何验证。完成后停下，等待执行阶段。\n\n";

export const DUAL_EXEC_PREFIX =
  "【执行阶段】请按上面确定的方案开始实施。逐项完成并验证；如果实际情况与方案不符，做最小必要调整，并在最终回复中说明偏差。";

export type DirectiveKind = "plan" | "dualPlan" | "dualExec" | "plain";

// 剥离指令前缀，返回阶段类型与用户原文。执行阶段的消息还可能带"方案文档：…"行。
export function stripDirective(raw: string): { kind: DirectiveKind; text: string } {
  if (raw.startsWith(PLAN_PREFIX)) {
    return { kind: "plan", text: raw.slice(PLAN_PREFIX.length).trim() };
  }
  if (raw.startsWith(DUAL_PLAN_PREFIX)) {
    return { kind: "dualPlan", text: raw.slice(DUAL_PLAN_PREFIX.length).trim() };
  }
  if (raw.startsWith(DUAL_EXEC_PREFIX)) {
    const rest = raw
      .slice(DUAL_EXEC_PREFIX.length)
      .replace(/^\s*方案文档：\S+[^\n]*\n?/u, "")
      .trim();
    return { kind: "dualExec", text: rest };
  }
  return { kind: "plain", text: raw };
}

// pi 在内联图片被缩放/转码后会往消息正文追加给模型看的提示：
//   [Image: original 2597x558, displayed at 2000x430. Multiply coordinates by 1.30 ...]
//   [Image converted from image/webp to image/png.]
// 这些是模型侧的坐标映射元信息，不属于用户输入，展示层剥掉。
const IMAGE_NOTE_RE =
  /\n?\s*\[Image:?\s*(?:converted from [^\]]*? to [^\]]*?|original \d+x\d+[^\]]*)\]\s*/g;

export function stripImageNotes(text: string): string {
  return text.replace(IMAGE_NOTE_RE, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 附件解析结果（attachments.ts 的 wrap() 生成）：
//   <attachment name="方案.docx">
//   （docx 提取的纯文本，格式信息未保留）
//   ……正文……
//   </attachment>
// 以及未解析/超限类的 【附件 xxx：说明】 标记。正文是给模型读的，用户消息气泡
// 只显示他自己写的话，附件由上方 chip 承载（点开可预览原件）——会话存真相、
// 展示层剥离，与 stripDirective / stripImageNotes 同一约定。
const ATTACHMENT_BLOCK_RE = /<attachment\s+[^>]*>[\s\S]*?<\/attachment>/g;
const ATTACHMENT_MARK_RE = /【附件\s+[^】\n]*】/g;

export function stripAttachmentBlocks(text: string): string {
  return text
    .replace(ATTACHMENT_BLOCK_RE, "\n\n")
    .replace(ATTACHMENT_MARK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
