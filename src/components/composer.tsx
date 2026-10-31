import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CornerDownLeftIcon,
  FileIcon,
  ListPlusIcon,
  PlusIcon,
  SlashIcon,
  SquareIcon,
  Trash2Icon,
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
import type { CommandInfo, QueueState } from "@/lib/pi";

/** Local commands the composer handles itself, merged with pi's own list. */
export const LOCAL_COMMANDS = [
  { name: "new", description: "开始新会话" },
  { name: "compact", description: "压缩上下文" },
  { name: "plan", description: "切换计划模式：只出方案不改文件" },
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

  const queueItems = useMemo(
    () => [
      ...queue.steering.map((text) => ({ text, kind: "打断" })),
      ...queue.followUp.map((text) => ({ text, kind: "排队" })),
    ],
    [queue],
  );
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
        onSubmit={handleSubmit}
      >
        {queueItems.length > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-3">
            {queueItems.map((item, i) => (
              <span
                className="flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                key={i}
              >
                <span className="text-muted-foreground">{item.kind}</span>
                <span className="max-w-40 truncate">{item.text}</span>
              </span>
            ))}
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
          <PromptInputTextarea
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
          <PromptInputTools>
            {children}
            <PromptInputButton
              className={cn("gap-1 text-xs", planMode && "text-primary")}
              onClick={onTogglePlan}
              title={planMode ? "计划模式已开启" : "计划模式：只出方案，不改文件"}
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
            {streaming ? (
              <PromptInputButton
                className="gap-1 text-xs text-destructive hover:text-destructive"
                onClick={onStop}
                title="停止生成"
              >
                <SquareIcon className="size-3" fill="currentColor" />
                停止
              </PromptInputButton>
            ) : null}
          </PromptInputTools>
          <PromptInputSubmit
            className={cn("size-8 shrink-0 rounded-full", streaming && "w-auto gap-1 px-3 text-xs")}
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
