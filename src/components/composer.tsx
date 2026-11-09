import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CornerDownLeftIcon,
  FileIcon,
  ListPlusIcon,
  PlusIcon,
  SlashIcon,
  SquareIcon,
  Loader2Icon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { stripAttachmentBlocks } from "@/lib/promptPrefixes";
import type { CommandInfo, QueueState } from "@/lib/pi";

/** Local commands the composer handles itself, merged with pi's own list. */
export const LOCAL_COMMANDS = [
  { name: "new", description: "开始新会话" },
  { name: "compact", description: "压缩上下文" },
  { name: "plan", description: "切换计划模式：只读探索，产出计划后经你批准" },
];

type Suggestion =
  | { kind: "command"; name: string; description: string }
  | { kind: "file"; path: string };

export function Composer({
  streaming,
  commands,
  cwd,
  queue,
  onClearQueue,
  onQueueInsert,
  onSubmit,
  onStop,
  onLocalCommand,
  onTogglePlan,
  planMode,
  children,
}: {
  streaming: boolean;
  commands: CommandInfo[];
  cwd: string;
  queue: QueueState;
  onClearQueue: () => void;
  // 立即把某条排队消息插进当前回合（不再需要 Option+Enter）
  onQueueInsert: (text: string, kind: "steering" | "followUp") => Promise<void> | void;
  onSubmit: (message: PromptInputMessage, behavior?: "steer" | "followUp") => void;
  onStop: () => void;
  onLocalCommand: (name: string) => void;
  onTogglePlan: () => void;
  planMode: boolean;
  children?: React.ReactNode;
}) {
  const controller = usePromptInputController();
  const attachments = usePromptInputAttachments();
  const text = controller.textInput.value;
  const hasText = text.trim().length > 0;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const requestRef = useRef(0);
  // Option/Alt+Enter asks pi to steer instead of queueing. The submit event
  // cannot carry the modifier, so stash it here for exactly one submit.
  const behaviorRef = useRef<"steer" | undefined>(undefined);

  const slashQuery = text.match(/^\/(\S*)$/)?.[1];
  const atQuery = text.match(/(?:^|\s)@([^\s@]*)$/)?.[1];

  const commandList = useMemo(() => {
    const merged = [
      ...LOCAL_COMMANDS,
      ...commands
        .filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))
        .map((c) => ({ name: c.name, description: c.description ?? c.source ?? "" })),
    ];
    const q = (slashQuery ?? "").toLowerCase();
    return merged.filter((c) => c.name.toLowerCase().includes(q));
  }, [commands, slashQuery]);

  // @-mentions come from a bounded directory walk in the main process.
  useEffect(() => {
    if (atQuery === undefined) {
      setSuggestions([]);
      return;
    }
    const id = ++requestRef.current;
    window.pi.files(cwd, atQuery).then((files) => {
      if (id !== requestRef.current) return;
      setSuggestions(files.map((path) => ({ kind: "file" as const, path })));
      setActive(0);
    });
  }, [atQuery, cwd]);

  useEffect(() => {
    if (slashQuery !== undefined) {
      setSuggestions(commandList.map((c) => ({ kind: "command" as const, ...c })));
      setActive(0);
    }
  }, [slashQuery, commandList]);

  const pick = useCallback(
    (item: Suggestion) => {
      if (item.kind === "command") {
        controller.textInput.setInput("");
        if (LOCAL_COMMANDS.some((l) => l.name === item.name)) onLocalCommand(item.name);
        else controller.textInput.setInput(`/${item.name} `);
      } else {
        controller.textInput.setInput(text.replace(/@([^\s@]*)$/, `@${item.path} `));
      }
      setSuggestions([]);
    },
    [controller, onLocalCommand, text],
  );

  // PromptInputTextarea's built-in Enter handling is overridden by this
  // handler, so everything Enter does lives here.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pick(suggestions[active]);
      } else if (event.key === "Escape") {
        setSuggestions([]);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!text.trim()) return;
      behaviorRef.current = event.altKey ? "steer" : undefined;
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleSubmit = (message: PromptInputMessage) => {
    const behavior = behaviorRef.current;
    behaviorRef.current = undefined;
    onSubmit(message, behavior);
  };

  // Clicking a suggestion happens on mousedown (with preventDefault), so a
  // short delay lets that land before blur tears the popup down.
  const onBlur = () => setTimeout(() => setSuggestions([]), 120);

  // 「插入」是 清空队列 + 按新顺序重发 的多步异步操作。点击后**把目标那一行
  // 就地变成「插入中…」**（不是再叠一个占位 chip，否则会出现两条一模一样的
  // item），并跟着这条消息（可能从"排队"改记为"打断"）一直转到它被消费为止。
  const [insertMark, setInsertMark] = useState<{
    raw: string;
    text: string;
    startedAt: number;
  } | null>(null);
  const insertQueued = async (item: { raw: string; text: string; kind: "打断" | "排队" }) => {
    if (insertMark) return;
    setInsertMark({ raw: item.raw, text: item.text, startedAt: Date.now() });
    // 插入按原始文本匹配 pi 的队列（含附件正文），展示用的 text 是剥离后的
    try {
      await onQueueInsert(item.raw, item.kind === "打断" ? "steering" : "followUp");
    } catch {
      // 插入失败也要让「插入中」收尾（队列没变，靠 10s 兜底）
    }
  };

  // 目标被 pi 消费掉（两个队列里都不在了）就收掉「插入中」；最短 350ms，
  // 避免 IPC 太快用户看不到任何反馈。还在队列里（steer 等到边界）就一直转。
  useEffect(() => {
    if (!insertMark) return;
    const present = queue.steering.includes(insertMark.raw) || queue.followUp.includes(insertMark.raw);
    const delay = present
      ? 10_000 // 兜底：pi 没回 queue_update 时最多转 10s
      : Math.max(0, 350 - (Date.now() - insertMark.startedAt));
    const timer = setTimeout(() => setInsertMark(null), delay);
    return () => clearTimeout(timer);
  }, [queue, insertMark]);

  const queueItems = useMemo(() => {
    // 同一段文本可能排队多次：用 (kind, raw) 的出现序号定位"点了插入的那一条"，
    // 队列下标在移除后会左移，序号不会。
    const seen = new Map<string, number>();
    const make = (raw: string, kind: "打断" | "排队") => {
      const key = `${kind}|${raw}`;
      const ordinal = (seen.get(key) ?? 0) + 1;
      seen.set(key, ordinal);
      // 队列 chip 只显示用户原文：附件解析正文是给模型的，不塞进排队预览
      return { raw, text: stripAttachmentBlocks(raw), kind, ordinal };
    };
    return [
      ...queue.steering.map((raw) => make(raw, "打断")),
      ...queue.followUp.map((raw) => make(raw, "排队")),
    ];
  }, [queue]);
  const commandItems = suggestions.filter((s) => s.kind === "command");
  const fileItems = suggestions.filter((s) => s.kind === "file");

  return (
    <div className="relative">
      {suggestions.length > 0 ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-auto rounded-xl border bg-popover p-1 shadow-lg">
          {commandItems.length > 0 ? (
            <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground">命令</p>
          ) : null}
          {commandItems.map((item) => (
            <SuggestionRow
              active={suggestions[active] === item}
              item={item}
              key={item.name}
              onHover={() => setActive(suggestions.indexOf(item))}
              onPick={() => pick(item)}
            />
          ))}
          {fileItems.length > 0 ? (
            <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground">文件</p>
          ) : null}
          {fileItems.map((item) => (
            <SuggestionRow
              active={suggestions[active] === item}
              item={item}
              key={item.path}
              onHover={() => setActive(suggestions.indexOf(item))}
              onPick={() => pick(item)}
            />
          ))}
        </div>
      ) : null}

      <PromptInput
        className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm"
        // 拖到窗口任意位置都能加附件（含从资源管理器/桌面拖入，支持多选）
        globalDrop
        multiple
        onSubmit={handleSubmit}
      >
        {queueItems.length > 0 || insertMark ? (
          <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-3">
            {(() => {
              // 只把**第一条**同文本的目标项就地转成「插入中」，其余（重复排队的
              // 另一份）保持普通排队态，避免出现两条一样的 item。
              let insertShown = false;
              return queueItems.map((item) => {
                const isInserting =
                  Boolean(insertMark) && !insertShown && insertMark!.raw === item.raw;
                if (isInserting) insertShown = true;
                return isInserting ? (
                // 正在插入：就地换成「插入中…」，不再重复渲染原始排队项
                <span
                  className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 py-0.5 pr-2 pl-1.5 text-[11px] text-primary"
                  key={`${item.kind}-${item.ordinal}`}
                >
                  <Loader2Icon className="size-3 animate-spin" />
                  <span className="text-primary/70">插入中…</span>
                  <span className="max-w-40 truncate">{item.text}</span>
                </span>
              ) : (
                <span
                  className="group/q flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-1.5 text-[11px]"
                  key={`${item.kind}-${item.ordinal}`}
                  title={item.text}
                >
                  <span className="text-muted-foreground">{item.kind}</span>
                  <span className="max-w-40 truncate">{item.text}</span>
                  <button
                    className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-primary/80 transition-colors hover:bg-primary/15 hover:text-primary disabled:opacity-60"
                    disabled={Boolean(insertMark)}
                    onClick={() => void insertQueued(item)}
                    title="立即插入当前回合（不等当前回复结束）"
                    type="button"
                  >
                  <ZapIcon className="size-3" />
                  插入
                </button>
              </span>
              );
              });
            })()}
            {insertMark && !queueItems.some((i) => i.raw === insertMark.raw) ? (
              // clear_queue 与重放之间可能有一帧队列为空：补一个占位，别让反馈闪没
              <span className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 py-0.5 pr-2 pl-1.5 text-[11px] text-primary">
                <Loader2Icon className="size-3 animate-spin" />
                <span className="text-primary/70">插入中…</span>
                <span className="max-w-40 truncate">{insertMark.text}</span>
              </span>
            ) : null}
            <button
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
              onClick={onClearQueue}
              type="button"
            >
              <Trash2Icon className="size-3" /> 清空队列
            </button>
          </div>
        ) : null}

        <PromptInputAttachments>
          {(file) => <PromptInputAttachment className="h-7 text-xs" data={file} />}
        </PromptInputAttachments>

        <PromptInputBody>
          <PromptInputTextarea data-editor="main"
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            placeholder={
              streaming
                ? "回复处理中：Enter 排队 · Option+Enter 立即插入"
                : "输入消息…（Enter 发送 · / 命令 · @ 引用文件）"
            }
          />
        </PromptInputBody>
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools className="min-w-0 flex-1 flex-wrap">
            {children}
            <PromptInputButton
              className={cn("gap-1 text-xs", planMode && "text-primary")}
              onClick={onTogglePlan}
              title={
                planMode
                  ? "计划模式已开启：工具只读，模型产出计划后由你批准"
                  : "计划模式：先只读探索、产出计划，经你批准后才开始改文件"
              }
            >
              {planMode ? "计划中" : "计划"}
            </PromptInputButton>
            <PromptInputButton
              className="text-xs"
              onClick={attachments.openFileDialog}
              title="添加图片 / 文件"
            >
              <PlusIcon className="size-4" />
            </PromptInputButton>
          </PromptInputTools>
          {streaming && !hasText ? (
            <PromptInputButton
              className="size-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={onStop}
              title="停止生成"
            >
              <SquareIcon className="size-3.5" fill="currentColor" />
            </PromptInputButton>
          ) : (
            <PromptInputSubmit
              className={cn("size-8 shrink-0 rounded-full", streaming && "w-auto gap-1 px-3 text-xs")}
              disabled={!hasText}
              title={streaming ? "Enter 排队 · Option+Enter 立即插入" : "发送（Enter）"}
            >
              {streaming ? (
                <>
                  <ListPlusIcon className="size-3.5" /> 排队
                </>
              ) : (
                <ArrowUpIcon className="size-4" />
              )}
            </PromptInputSubmit>
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function SuggestionRow({
  item,
  active,
  onHover,
  onPick,
}: {
  item: Suggestion;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
        active && "bg-accent",
      )}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      type="button"
    >
      {item.kind === "command" ? (
        <SlashIcon className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon className="size-3 shrink-0 text-muted-foreground" />
      )}
      {item.kind === "command" ? (
        <>
          <span className="shrink-0 font-mono">{item.name}</span>
          {item.description ? (
            <span className="truncate text-muted-foreground">{item.description}</span>
          ) : null}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono">
          <span className="text-muted-foreground">{dirOf(item.path)}</span>
          {baseOf(item.path)}
        </span>
      )}
      {active ? (
        <CornerDownLeftIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
      ) : null}
    </button>
  );
}

// File paths may use either separator depending on the OS.
const lastSep = (path: string) => Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
const dirOf = (path: string) => {
  const i = lastSep(path);
  return i >= 0 ? path.slice(0, i + 1) : "";
};
const baseOf = (path: string) => {
  const i = lastSep(path);
  return i >= 0 ? path.slice(i + 1) : path;
};
