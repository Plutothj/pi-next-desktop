import fs from "node:fs";
import path from "node:path";

// todo 扩展（Pi Desktop 维护，勿手改）：给模型注册 todo 工具，清单以
// **字符串数组** widget 输出（RPC 模式唯一支持的形态，桌面端的 widget 面板
// 负责渲染成核对清单）。
//
// 状态存在 tool result 的 details 里 —— fork/分支后每个分支看到的是它那一刻
// 的清单，天然正确，不落外部文件。

export const TODO_EXTENSION_SOURCE = `// 由 Pi Desktop 维护（勿手改，会被重新生成）——todo 清单。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const WIDGET_KEY = "todo";

interface Todo { id: number; text: string; done: boolean }
interface TodoDetails { action: string; todos: Todo[]; nextId: number; error?: string }

const Params = Type.Object({
  action: StringEnum(["list", "add", "toggle", "remove", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo id (for toggle/remove)" })),
});

export default function (pi: ExtensionAPI) {
  let todos: Todo[] = [];
  let nextId = 1;

  // 从当前分支的 tool result details 重建（fork 后自动正确）
  const reconstruct = (ctx: ExtensionContext) => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message as { role?: string; toolName?: string; details?: TodoDetails };
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
      if (msg.details?.todos) {
        todos = msg.details.todos;
        nextId = msg.details.nextId ?? todos.length + 1;
      }
    }
  };

  // 清单 → 字符串数组（widget 面板会解析标题/进度/✓✗）
  const paint = (ctx: ExtensionContext) => {
    if (todos.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const done = todos.filter((t) => t.done).length;
    const lines = [
      \`--- Todo \${done}/\${todos.length} ---\`,
      ...todos.map((t) => (t.done ? \`✓ #\${t.id} \${t.text}\` : \`▸ #\${t.id} \${t.text}\`)),
    ];
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
  };

  pi.on("session_start", async (_e, ctx) => { reconstruct(ctx); paint(ctx); });
  pi.on("session_tree", async (_e, ctx) => { reconstruct(ctx); paint(ctx); });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage the session todo list (survives fork/branch). Actions: list, add(text), toggle(id), remove(id), clear",
    promptSnippet: "Track a multi-step task with an explicit checklist (add items, toggle them done)",
    // promptGuidelines 会平铺进系统提示的 <rules> 段，每条必须点名工具
    // （不能写 "this tool"），否则模型不知道指哪个工具。
    promptGuidelines: [
      "Use the todo tool for any task that needs three or more distinct steps: add the steps first, then toggle each one done as you finish it.",
      "The todo tool's list lives in the conversation, so it survives forking and switching branches; re-read it with action=list when unsure what remains.",
      "Keep the todo tool list short and concrete (one line per step), and clear it with action=clear once the whole task is finished.",
    ],
    parameters: Params,

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: add 需要 text" }],
              details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
            };
          }
          const item: Todo = { id: nextId++, text: params.text, done: false };
          todos = [...todos, item];
          paint(ctx);
          return {
            content: [{ type: "text", text: \`已添加 #\${item.id}: \${item.text}\` }],
            details: { action: "add", todos, nextId } as TodoDetails,
          };
        }
        case "toggle": {
          const item = todos.find((t) => t.id === params.id);
          if (!item) {
            return {
              content: [{ type: "text", text: \`找不到 #\${params.id}\` }],
              details: { action: "toggle", todos, nextId, error: "not found" } as TodoDetails,
            };
          }
          todos = todos.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t));
          paint(ctx);
          return {
            content: [{ type: "text", text: \`#\${item.id} \${item.done ? "改为未完成" : "已完成"}\` }],
            details: { action: "toggle", todos, nextId } as TodoDetails,
          };
        }
        case "remove": {
          todos = todos.filter((t) => t.id !== params.id);
          paint(ctx);
          return {
            content: [{ type: "text", text: \`已删除 #\${params.id}\` }],
            details: { action: "remove", todos, nextId } as TodoDetails,
          };
        }
        case "clear": {
          todos = [];
          nextId = 1;
          paint(ctx);
          return {
            content: [{ type: "text", text: "清单已清空" }],
            details: { action: "clear", todos, nextId } as TodoDetails,
          };
        }
        default: {
          const text = todos.length
            ? todos.map((t) => \`[\${t.done ? "x" : " "}] #\${t.id} \${t.text}\`).join("\\n")
            : "清单为空";
          return {
            content: [{ type: "text", text }],
            details: { action: "list", todos, nextId } as TodoDetails,
          };
        }
      }
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
