import fs from "node:fs";
import path from "node:path";

// todo 扩展（Pi Desktop 维护，勿手改）：给模型注册 **TodoWrite** 工具，清单以
// **字符串数组** widget 输出（RPC 模式唯一支持的形态，桌面端的 widget 面板
// 负责渲染成核对清单）。
//
// 契约对齐 Claude Code / ZCode / opencode 的 TodoWrite：每次调用发送**全量
// 列表**（content + status），一次性替换上一份。以前的 add/toggle/remove 增量
// 接口要求模型一步步维护 id，实测模型经常懒得建清单、也懒得逐条打勾；全量
// 替换是这几家主流实现的共同选择，也是模型训练里最熟的形状。
//
// 状态存在 tool result 的 details 里 —— fork/分支后每个分支看到的是它那一刻
// 的清单，天然正确，不落外部文件。

export const TODO_EXTENSION_SOURCE = `// 由 Pi Desktop 维护（勿手改，会被重新生成）——TodoWrite 清单。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const WIDGET_KEY = "todo";
const TOOL_NAME = "TodoWrite";

// 模型迟迟不建/不更新清单时，在回合边界提醒一次（ZCode/Claude Code 的思路）：
// 连续 TURNS_SINCE_WRITE 个 assistant 回合没有写清单、其中至少 MIN_TOOL_TURNS
// 轮在跑工具。提醒后重新计数（下一轮提醒至少再隔同样多回合）。
const TURNS_SINCE_WRITE = 6;
const MIN_TOOL_TURNS = 4;

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo { id: number; text: string; done: boolean; status: TodoStatus }
interface TodoDetails { action: string; todos: Todo[]; nextId: number; error?: string }

const Params = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Brief description of the task" }),
      status: StringEnum(["pending", "in_progress", "completed"] as const, {
        description: "pending, in_progress or completed",
      }),
      priority: Type.Optional(
        StringEnum(["high", "medium", "low"] as const, { description: "Optional priority" }),
      ),
    }),
    { description: "The updated todo list. Send the full list on every call; it replaces the previous one." },
  ),
});

const normalizeStatus = (value: unknown, done?: unknown): TodoStatus =>
  value === "completed" || value === "in_progress" || value === "pending"
    ? value
    : Boolean(done)
      ? "completed"
      : "pending";

// tool result details（新旧两代格式）→ 内存列表
const normalizeTodos = (raw: any[]): Todo[] =>
  raw
    .map((item, index) => {
      const text = String(item?.content ?? item?.text ?? "").trim();
      const done = item?.status ? item.status === "completed" : Boolean(item?.done);
      const status = normalizeStatus(item?.status, item?.done);
      return text ? { id: index + 1, text, done, status } : null;
    })
    .filter((item): item is Todo => Boolean(item));

export default function (pi: ExtensionAPI) {
  let todos: Todo[] = [];
  // 上一回合已完成的项：下一回合开始时从面板撤掉（状态保留）
  let hiddenDoneTexts = new Set<string>();
  // agent_before_settle 未完成项提醒的防循环：同一批签名只提醒一次
  let lastNudgeSig: string | null = null;
  // 连续没写清单的回合数（用于"懒"的提醒）
  let turnsSinceWrite = 0;
  let toolTurnsSinceWrite = 0;
  // 最近的 UI 上下文：agent_start 这类没有 ctx 的事件里重绘用
  let lastCtx: ExtensionContext | null = null;

  // 从当前分支的 tool result details 重建（fork 后自动正确）
  const reconstruct = (ctx: ExtensionContext) => {
    todos = [];
    hiddenDoneTexts = new Set();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message as { role?: string; toolName?: string; details?: TodoDetails & { todos?: any[] } };
      if (msg.role !== "toolResult" || (msg.toolName !== TOOL_NAME && msg.toolName !== "todo")) continue;
      if (Array.isArray(msg.details?.todos)) todos = normalizeTodos(msg.details!.todos as any[]);
    }
  };

  // 清单 → 字符串数组（widget 面板会解析标题/进度/✓✗）。
  // 已完成且"上一回合就完成了"的项不再显示；没有可见项时直接撤掉卡片。
  const paint = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (todos.length === 0) {
      hiddenDoneTexts = new Set();
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const shown = todos.filter((t) => !(t.done && hiddenDoneTexts.has(t.text)));
    if (shown.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const done = todos.filter((t) => t.done).length;
    const lines = [
      \`--- Todo \${done}/\${todos.length} ---\`,
      ...shown.map((t) => (t.done ? \`✓ #\${t.id} \${t.text}\` : \`▸ #\${t.id} \${t.text}\`)),
    ];
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
  };

  const summarize = () => {
    if (todos.length === 0) return "Todos cleared";
    const counts = [
      \`\${todos.filter((t) => t.done).length}/\${todos.length} completed\`,
      \`\${todos.filter((t) => t.status === "in_progress").length} in progress\`,
      \`\${todos.filter((t) => t.status === "pending").length} pending\`,
    ];
    const active = todos.filter((t) => t.status === "in_progress").map((t) => JSON.stringify(t.text));
    return \`Todos updated: \${counts.join(", ")}\${active.length ? \`. In progress: \${active.join(", ")}\` : ""}\`;
  };

  pi.on("session_start", async (_e, ctx) => {
    lastNudgeSig = null;
    reconstruct(ctx);
    paint(ctx);
  });
  pi.on("session_tree", async (_e, ctx) => {
    lastNudgeSig = null;
    reconstruct(ctx);
    paint(ctx);
  });
  // 新回合开始：把上一回合完成的项从面板撤掉（不再占地方），未完成的继续显示。
  pi.on("agent_start", async () => {
    for (const t of todos) if (t.done) hiddenDoneTexts.add(t.text);
    if (lastCtx) paint(lastCtx);
  });
  // 新的一次用户输入（prompt/steer）重新允许提醒一次；不能用 agent_start
  // （boundary 的 continue 会在同一轮里再发一次 provider 请求，会无限提醒）。
  pi.on("input", async () => {
    lastNudgeSig = null;
  });

  // 回合边界：模型连续多轮在干活却没碰清单 → 注入提醒并继续。
  // （模型训练里最熟的 TodoWrite 契约是"全量列表 + status"，光靠 guidelines
  // 不够，ZCode 也是按回合数定期提醒。）
  pi.on("turn_end", async (event: any) => {
    turnsSinceWrite += 1;
    if (Array.isArray(event?.toolResults) && event.toolResults.length > 0) toolTurnsSinceWrite += 1;
    if (turnsSinceWrite < TURNS_SINCE_WRITE) return;
    if (toolTurnsSinceWrite < MIN_TOOL_TURNS) return;
    // 提醒后重新计数：下一轮提醒至少再隔 TURNS_SINCE_WRITE 个回合
    const idleTurns = turnsSinceWrite;
    const toolTurns = toolTurnsSinceWrite;
    turnsSinceWrite = 0;
    toolTurnsSinceWrite = 0;
    // 全部完成也算"当前没有在跟踪的活"，提醒建一份新的清单
    const open = todos.filter((t) => !t.done);
    const list = open.length
      ? \`当前清单：\${todos.map((t) => \`\${t.status} \${t.text}\`).join("；")}。\`
      : "";
    const content = open.length
      ? \`[todo 提醒] 你已经 \${idleTurns} 个回合没有更新清单了。\${list}请调用 TodoWrite 发送全量列表，把正在做的标成 in_progress、做完的立即标成 completed；再继续。\`
      : \`[todo 提醒] 这轮任务已经跑了 \${toolTurns} 轮工具调用，但还没有建立清单。如果它需要 3 个以上步骤，请现在调用 TodoWrite 建立清单（content + status，先标一项 in_progress），再继续执行。单一简单任务可以忽略。\`;
    return {
      entries: [
        ...(event?.entries ?? []),
        {
          type: "custom_message" as const,
          customType: "pi-desktop-todo-reminder",
          display: false,
          content,
        },
      ],
      continue: true,
    };
  });

  // 回合真正结束前（agent_before_settle）还有未完成项 → 注入隐藏提醒并强制
  // 再跑一次模型请求。这是 pi 官方的 actionable boundary；在 turn_end 里直接
  // sendUserMessage 会落在"回合仍在跑"的状态里被拒。
  pi.on("agent_before_settle", async (event: any) => {
    const pending = todos.filter((t) => !t.done);
    if (pending.length === 0) {
      lastNudgeSig = null;
      return;
    }
    const sig = pending.map((t) => \`#\${t.id} \${t.text}\`).join(" | ");
    if (sig === lastNudgeSig) return;
    lastNudgeSig = sig;
    return {
      entries: [
        ...(event?.entries ?? []),
        {
          type: "custom_message" as const,
          customType: "pi-desktop-todo-reminder",
          display: false,
          content:
            \`[todo 自动提醒] 清单里还有未完成项：\${pending.map((t) => \`\${t.status} \${t.text}\`).join("；")}。\` +
            "已完成的事项请立即用 TodoWrite 的全量列表标成 completed；不再需要的直接删掉；" +
            "确有剩余工作就继续执行。先处理清单，不要只用文字回复。",
        },
      ],
      continue: true,
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "TodoWrite",
    description:
      "Create and update a todo list for the current session. The user sees it as your working plan.\\n\\n" +
      "Use it proactively when a task has 3 or more distinct steps, when the user gives several tasks, or when the user asks for a todo list. " +
      "Skip it for a single simple task or a purely conversational request. When in doubt, use it.\\n\\n" +
      "- Send the full list on every call; it replaces the previous one.\\n" +
      "- Mark items as in_progress when you start them and completed as soon as they are actually done.\\n" +
      "- Only call it when the list changes.",
    promptSnippet: "Track a multi-step task with an explicit checklist (full list + status)",
    // promptGuidelines 会平铺进系统提示的 <rules> 段，每条必须点名工具
    promptGuidelines: [
      "Use the TodoWrite tool proactively for any task with 3 or more distinct steps, when the user gives several tasks, or when the user asks for a todo list. Do this before the first edit or command, not after the work is done.",
      "On every TodoWrite call, send the full todo list; each item has content and status (pending, in_progress, completed). The call replaces the previous list, so mark exactly one item in_progress and switch items to completed the moment their work is actually finished.",
      "Never end a reply while completed work is still marked pending or in_progress in the TodoWrite list.",
      "The TodoWrite list lives in the conversation, so it survives forking and switching branches. Keep items short and concrete, and remove items that are no longer needed.",
    ],
    parameters: Params,

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = (params as any)?.todos;
      if (!Array.isArray(raw)) {
        return {
          content: [{ type: "text", text: "Error: TodoWrite 需要 todos（全量列表）" }],
          details: { action: "set", todos, nextId: todos.length + 1, error: "todos required" } as TodoDetails,
        };
      }
      todos = normalizeTodos(raw);
      hiddenDoneTexts = new Set();
      turnsSinceWrite = 0;
      toolTurnsSinceWrite = 0;
      paint(ctx);
      return {
        content: [{ type: "text", text: summarize() }],
        details: { action: "set", todos, nextId: todos.length + 1 } as TodoDetails,
      };
    },
  });
}
`;

export function installTodoExtension(agentDir) {
  try {
    const dir = path.join(agentDir, "extensions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "todo.ts");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== TODO_EXTENSION_SOURCE) fs.writeFileSync(file, TODO_EXTENSION_SOURCE);
    return file;
  } catch {
    return null;
  }
}
