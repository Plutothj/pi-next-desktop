import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeftIcon, FileIcon, SlashIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import type { CommandInfo } from "@/lib/pi";

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
  onSubmit: (message: PromptInputMessage) => void;
  onStop: () => void;
  onLocalCommand: (name: string) => void;
  onTogglePlan: () => void;
  planMode: boolean;
  children?: React.ReactNode;
}) {
  const controller = usePromptInputController();
  const text = controller.textInput.value;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const requestRef = useRef(0);

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

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions.length) return;
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
  };

  return (
    <div className="relative">
      {suggestions.length > 0 ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-full overflow-auto rounded-lg border bg-popover p-1 shadow-lg">
          {suggestions.map((item, i) => (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                i === active && "bg-accent",
              )}
              key={item.kind === "file" ? item.path : item.name}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              type="button"
            >
              {item.kind === "command" ? (
                <SlashIcon className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3 shrink-0 text-muted-foreground" />
              )}
              <span className="shrink-0 font-mono">{item.kind === "command" ? item.name : item.path}</span>
              {item.kind === "command" && item.description ? (
                <span className="truncate text-muted-foreground">{item.description}</span>
              ) : null}
              {i === active ? (
                <CornerDownLeftIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            onKeyDown={onKeyDown}
            placeholder="问点什么…（Enter 发送，/ 命令，@ 引用文件）"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton
              className={cn("gap-1 text-xs", planMode && "text-primary")}
              onClick={onTogglePlan}
              title={planMode ? "计划模式已开启" : "计划模式：只出方案，不改文件"}
            >
              {planMode ? "计划中" : "计划"}
            </PromptInputButton>
            {children}
          </PromptInputTools>
          {streaming ? (
            <PromptInputButton onClick={onStop} title="停止">
              <span className="size-3 rounded-[1px] bg-current" />
            </PromptInputButton>
          ) : (
            <PromptInputSubmit status="ready" />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
