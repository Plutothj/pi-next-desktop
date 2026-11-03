// 扩展 widget 渲染：pi 的 setWidget 只给纯文本行（TUI 遗留约定）。
// 这里做轻量语义解析，比 TUI 好读但不发明协议：
//   "--- 标题 ---" / "## 标题"  → 卡片标题
//   "3/10" 或 "[####----]"     → 进度条
//   "✓ / ✔" 开头               → 绿色；"✗ / ✘ / ×" 开头 → 红色
//   "▸ / >" 开头               → 缩进强调
import { useState } from "react";
import { CheckCircle2Icon, CheckIcon, ChevronDownIcon, XCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Widget = { lines: string[]; placement: "above" | "below" };

const TITLE_RE = /^\s*(?:-{2,}\s*(.+?)\s*-{2,}|#{1,3}\s+(.+?))\s*$/;
const PROGRESS_FRAC_RE = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/;
const PROGRESS_BAR_RE = /^\s*\[([#=\-.\s]+)\]\s*(.*)$/;

function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {value}/{max}
        {label ? ` ${label}` : ""}
      </span>
    </div>
  );
}

function Line({ text }: { text: string }) {
  const frac = text.match(PROGRESS_FRAC_RE);
  if (frac) return <ProgressBar max={Number(frac[2])} value={Number(frac[1])} />;

  const bar = text.match(PROGRESS_BAR_RE);
  if (bar) {
    const filled = (bar[1].match(/[#=]/g) ?? []).length;
    const total = bar[1].length || 1;
    return <ProgressBar label={bar[2] || undefined} max={total} value={filled} />;
  }

  if (/^\s*[✓✔]/.test(text)) {
    return (
      <p className="flex items-start gap-1.5 py-0.5 text-emerald-600/90">
        <CheckCircle2Icon className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{text.replace(/^\s*[✓✔]\s*/, "")}</span>
      </p>
    );
  }
  if (/^\s*[✗✘×]/.test(text)) {
    return (
      <p className="flex items-start gap-1.5 py-0.5 text-rose-500/90">
        <XCircleIcon className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{text.replace(/^\s*[✗✘×]\s*/, "")}</span>
      </p>
    );
  }
  if (/^\s*[▸>]/.test(text)) {
    return (
      <p className="break-words py-0.5 pl-2 text-foreground/80">
        {text.replace(/^\s*[▸>]\s*/, "")}
      </p>
    );
  }
  return <p className="break-words py-0.5 text-muted-foreground">{text}</p>;
}

function WidgetCard({ name, widget }: { name: string; widget: Widget }) {
  // todo 这类清单走专门的核对清单渲染（复选框 + 完成划线 + 全完成折叠）
  const todo = parseTodoWidget(widget.lines);
  if (todo) return <TodoCard name={name} todo={todo} />;

  // 首行是标题就提出来，否则用 key 当标题
  const lines = [...widget.lines];
  let title: string | null = null;
  const first = lines[0]?.match(TITLE_RE);
  if (first) {
    title = first[1] ?? first[2] ?? null;
    lines.shift();
  }
  if (!title && lines.every((l) => !l.trim())) return null;

  return (
    <div className="w-fit max-w-full rounded-lg border bg-card/40 px-2.5 py-1.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70">
        <span className="size-1 rounded-full bg-muted-foreground/40" />
        {title ?? name}
      </div>
      <div className="max-h-40 space-y-px overflow-auto text-[11px] leading-5">
        {lines.map((line, i) => (
          <Line key={i} text={line} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- todo 清单

type TodoItem = { id: string; text: string; done: boolean };
type TodoParse = { title: string; items: TodoItem[]; doneCount: number };

// 解析 todo 扩展输出的 widget 行：
//   --- Todo 3/7 ---
//   ✓ #1 已完成的事项
//   ▸ #2 待办事项
function parseTodoWidget(lines: string[]): TodoParse | null {
  if (!lines.length) return null;
  const head = lines[0].match(/^\s*-{2,}\s*(Todo\b.*?)\s*-{2,}\s*$/i);
  if (!head) return null;
  const items: TodoItem[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^\s*([✓✔▸>·-])\s*#?(\d+)?\s*(.*)$/);
    if (!m) continue;
    const done = /[✓✔]/.test(m[1]);
    const text = (m[3] ?? "").trim();
    if (!text) continue;
    items.push({ id: m[2] ?? String(items.length + 1), text, done });
  }
  if (items.length === 0) return null;
  return { title: head[1], items, doneCount: items.filter((i) => i.done).length };
}

/** 核对清单：每项一个方框，完成打勾并划掉；全部完成自动折叠起来。 */
function TodoCard({ name, todo }: { name: string; todo: TodoParse }) {
  const allDone = todo.doneCount === todo.items.length;
  // 全部完成默认折叠；用户点开过就一直展开
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const open = !allDone || pinnedOpen;

  return (
    <div className="w-fit max-w-full rounded-lg border bg-card/40 px-2.5 py-1.5">
      <button
        className="flex w-full items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70 hover:text-muted-foreground"
        onClick={() => allDone && setPinnedOpen((v) => !v)}
        title={allDone ? (open ? "收起" : "展开已完成清单") : name}
        type="button"
      >
        <span
          className={cn(
            "size-1 rounded-full",
            allDone ? "bg-emerald-500" : "bg-amber-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{todo.title}</span>
        {allDone ? (
          <ChevronDownIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")}
          />
        ) : null}
      </button>

      {open ? (
        <ul className="mt-1 space-y-0.5">
          {todo.items.map((item) => (
            <li className="flex items-start gap-1.5 py-0.5 text-[11px] leading-5" key={item.id}>
              <span
                className={cn(
                  "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                  item.done
                    ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-600"
                    : "border-muted-foreground/30",
                )}
              >
                {item.done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  item.done ? "text-muted-foreground/60 line-through" : "text-foreground/85",
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WidgetStrip({
  widgets,
  placement,
}: {
  widgets: Record<string, Widget>;
  placement: "above" | "below";
}) {
  const entries = Object.entries(widgets).filter(([, w]) => w.placement === placement);
  if (entries.length === 0) return null;
  return (
    <div data-widget-card className={cn("flex flex-wrap items-start gap-2 px-1", placement === "above" ? "pb-1.5" : "pt-1.5")}>
      {entries.map(([key, widget]) => (
        <WidgetCard key={key} name={key} widget={widget} />
      ))}
    </div>
  );
}
