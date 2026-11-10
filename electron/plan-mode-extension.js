import fs from "node:fs";
import path from "node:path";

// 计划模式扩展（Pi Desktop 维护，勿手改）：真正的"只读规划 → 提交计划 → 用户批准"。
//
// 与旧实现（往用户 prompt 前面拼一段话术）不同，这里靠 pi 的三个机制：
// 1) 注册 EnterPlanMode / ExitPlanMode 工具，由模型主动进入/提交计划；
// 2) pi.on("tool_call") 拦住所有非只读工具（写文件、shell、表格写入……）；
// 3) before_agent_start 往系统提示里注入 plan mode 约束（不是用户消息）。
//
// 计划状态存在会话文件旁边的 <sessionFile>.plan-mode.json：桌面端写同一个文件，
// 所以 UI 开关和模型主动 EnterPlanMode 共用一份事实，重启/切会话也不会丢。

export const PLAN_MODE_EXTENSION_SOURCE = `// 由 Pi Desktop 维护（勿手改，会被重新生成）——计划模式。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

const MAX_PLAN_CHARS = 20_000;
const STATUS_KEY = "plan";
// 只读工具白名单：文件浏览/搜索；TodoWrite 与提问是会话内操作，不碰工作区。
const READONLY_TOOLS = new Set([
  "read", "grep", "glob", "find", "ls", "fd", "ripgrep", "search",
  "web_search", "websearch", "todo", "TodoWrite", "todowrite", "ask_user_question",
]);

function sessionFile(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? undefined;
  } catch {
    return undefined;
  }
}

function flagPath(ctx: ExtensionContext): string | undefined {
  const file = sessionFile(ctx);
  if (file) return file + ".plan-mode.json";
  const id = ctx.sessionManager?.getSessionId?.() ?? "session";
  const cwd = ctx.cwd ?? process.cwd();
  return path.join(cwd, ".pi", "plan-mode", id.replace(/[^A-Za-z0-9._-]/g, "-") + ".json");
}

function readState(ctx: ExtensionContext): { enabled: boolean; autoApprove: boolean; chain: boolean } {
  try {
    const file = flagPath(ctx);
    if (!file) return { enabled: false, autoApprove: false, chain: false };
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      enabled: Boolean(raw.enabled),
      autoApprove: Boolean(raw.autoApprove),
      chain: Boolean(raw.chain),
    };
  } catch {
    return { enabled: false, autoApprove: false, chain: false };
  }
}

function readFlag(ctx: ExtensionContext): boolean {
  return readState(ctx).enabled;
}

function writeFlag(ctx: ExtensionContext, enabled: boolean, autoApprove = false): void {
  try {
    const file = flagPath(ctx);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled, autoApprove: enabled ? Boolean(autoApprove) : false, updatedAt: Date.now() }),
      "utf8",
    );
  } catch {}
}

function paint(ctx: ExtensionContext): void {
  const on = readFlag(ctx);
  ctx.ui.setStatus(STATUS_KEY, on ? "计划模式 · 只读" : undefined);
}

function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true, details };
}

export default function (pi: ExtensionAPI) {
  // 会话恢复/分支切换后按落盘 flag 还原徽章（模型侧的拦截每次实时读文件）。
  pi.on("session_start", async (_event, ctx) => paint(ctx));
  pi.on("session_tree", async (_event, ctx) => paint(ctx));
  pi.on("turn_end", async (_event, ctx) => paint(ctx));

  // 系统提示注入：让模型知道当前只读、以及必须用 ExitPlanMode 提交计划。
  pi.on("before_agent_start", async (event, ctx) => {
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    if (!readFlag(ctx)) {
      delete sections["plan_mode"];
      return;
    }
    sections["plan_mode"] =
      "PLAN MODE IS ON (read-only). Explore with read-only tools only: read, grep, glob, find, ls. " +
      "File writes/edits, shell commands, and table writes are blocked by a tool gate. " +
      "Do not ask the user in prose whether the plan is acceptable; when the plan is complete and executable, " +
      "call ExitPlanMode with the full plan text. The user approves or rejects it; if rejected, revise the plan " +
      "and call ExitPlanMode again. Never call ExitPlanMode outside plan mode.";
  });

  // 工具闸门：计划模式下只放行只读工具（与 ZCode 的 Plan gate 同语义）。
  pi.on("tool_call", async (event, ctx) => {
    if (!readFlag(ctx)) return;
    const name = event.toolName;
    if (name === "EnterPlanMode" || name === "ExitPlanMode") return;
    if (name === "table" && event.input?.action === "read") return;
    if (READONLY_TOOLS.has(name)) return;
    return {
      block: true,
      reason:
        "Plan mode is read-only: tool \\"" + name + "\\" was blocked. " +
        "Use read-only tools (read/grep/glob/find/ls) to explore. When the plan is ready, " +
        "call ExitPlanMode with the full plan text; do not try to edit files or run commands.",
    };
  });

  pi.registerTool({
    name: "EnterPlanMode",
    label: "Enter Plan Mode",
    description:
      "Switch the session to read-only plan mode before non-trivial implementation work. Explore the codebase, design an approach, then submit it with ExitPlanMode for user approval. Use for new features, multi-file changes, refactors, architecture decisions, or unclear requirements.",
    promptSnippet:
      "Enter read-only plan mode for non-trivial implementation tasks, explore first, then call ExitPlanMode with the complete plan for approval",
    promptGuidelines: [
      "Call EnterPlanMode before starting non-trivial implementation work (new features, multi-file changes, refactors, architecture choices, unclear requirements). Skip it for one-line fixes, pure research, or tasks with very detailed user instructions.",
      "In plan mode only read-only tools work; file edits, shell commands, and writes are blocked by a tool gate.",
      "When the plan is ready, call ExitPlanMode with the full plan text. Do not ask whether the plan is okay in prose.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      writeFlag(ctx, true);
      paint(ctx);
      return {
        content: [
          {
            type: "text",
            text:
              "Entered plan mode. Explore the codebase with read-only tools and design the implementation. " +
              "When the plan is complete, call ExitPlanMode with the full plan text for user approval.",
          },
        ],
        details: { planEnabled: true },
      };
    },
  });

  pi.registerTool({
    name: "ExitPlanMode",
    label: "Exit Plan Mode",
    description:
      "In plan mode only: submit the final implementation plan for user approval and, if approved, exit plan mode to start implementing. The plan argument is exactly what the user reviews.",
    promptSnippet:
      "In plan mode, submit the complete implementation plan for user approval (ExitPlanMode)",
    promptGuidelines: [
      "Only call ExitPlanMode while plan mode is active, after the plan is complete.",
      "Put the full, concrete, executable plan in the plan argument; the user reviews that text.",
      "If the user rejects or asks for changes, stay in plan mode, revise, and call ExitPlanMode again.",
    ],
    parameters: Type.Object({
      plan: Type.String({
        description: "The complete implementation plan shown to the user for approval (markdown).",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = readState(ctx);
      if (!mode.enabled) {
        return errorResult(
          "ExitPlanMode can only be used while plan mode is active. If the plan was already approved, continue implementing.",
        );
      }
      const plan = String((params && params.plan) || "");
      if (!plan.trim()) return errorResult("The plan argument is empty; pass the full plan text.");
      if (plan.length > MAX_PLAN_CHARS) return errorResult("The plan is too long; keep it under 20000 characters.");

      // 双模型链路会预先打开 autoApprove：规划模型交计划后不打断，由执行模型接手。
      const approved = mode.autoApprove ? true : await ctx.ui.confirm("批准这份实施计划？", plan);
      if (!approved) {
        const feedback = await ctx.ui.editor("对计划的修改意见（可留空直接结束本回合）", "");
        paint(ctx);
        const note = String(feedback || "").trim();
        return errorResult(
          note
            ? "The user rejected the plan and asked for changes:\\n" + note + "\\nStay in plan mode, revise the plan, then call ExitPlanMode again."
            : "The user rejected the plan. Stay in plan mode and revise it, then call ExitPlanMode again.",
          { approved: false },
        );
      }

      // 批准后才落盘：作为 plan 文档，同时供 compact/resume 找回。
      let planFile = "";
      try {
        const cwd = ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? process.cwd();
        const id = ctx.sessionManager?.getSessionId?.() ?? "session";
        const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "session";
        const dir = path.join(cwd, ".pi", "plans");
        fs.mkdirSync(dir, { recursive: true });
        planFile = path.join(dir, "plan-" + safe + ".md");
        fs.writeFileSync(planFile, plan, "utf8");
      } catch {}

      if (mode.autoApprove || mode.chain) {
        // 双模型链路：保持 flag 到本回合结束（规划模型不能再趁机改文件），
        // 由链路在 settle 后关闭并切到执行模型。
        return {
          content: [
            {
              type: "text",
              text:
                "Plan recorded for the execution phase" +
                (planFile ? " at " + planFile : "") +
                ". Stop here and do not implement anything in this turn; the execution model will follow the document.",
            },
          ],
          details: { approved: true, auto: true, plan, planFile },
        };
      }

      writeFlag(ctx, false);
      paint(ctx);
      return {
        content: [
          {
            type: "text",
            text:
              "Plan approved. " +
              (planFile ? "Saved to " + planFile + ". " : "") +
              "Exit plan mode and implement it now; update the todo list first if appropriate.",
          },
        ],
        details: { approved: true, plan, planFile },
      };
    },
  });
}
`;

export function installPlanModeExtension(agentDir) {
  try {
    const dir = path.join(agentDir, "extensions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "plan-mode.ts");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== PLAN_MODE_EXTENSION_SOURCE) fs.writeFileSync(file, PLAN_MODE_EXTENSION_SOURCE);
    return file;
  } catch (err) {
    process.stderr.write(`[plan-mode-ext] 安装失败: ${err}\n`);
    return null;
  }
}
