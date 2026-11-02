import { memo, useMemo, useState } from "react";
import { mermaid } from "@streamdown/mermaid";
import { stripDirective } from "@/lib/promptPrefixes";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FilePenLineIcon,
  FileTextIcon,
  GitForkIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { FileDiff, editsOf } from "@/components/file-diff";
import { blocksOf, textOf, type ContentBlock, type PiMessage, type ToolExec } from "@/lib/pi";
import type { State } from "@/hooks/usePi";

const TOOL_ICONS: Record<string, typeof WrenchIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  write: FilePenLineIcon,
  edit: FilePenLineIcon,
  grep: SearchIcon,
  glob: SearchIcon,
};

/** One-line summary of the call: the command, the path, or the pattern. */
function toolPreview(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") {
    return args.command.split("\n")[0];
  }
  if (typeof args.path === "string") return args.path;
  if (typeof args.pattern === "string") return args.pattern;
  try {
    return JSON.stringify(args).slice(0, 120);
  } catch {
    return "";
  }
}

/**
 * ZCode-style compact tool log: one muted line with icon, name, argument
 * preview and status; details open on click. Replaces the old bordered card.
 */
function ToolRow({
  block,
  exec,
  result,
  streaming,
}: {
  block: Extract<ContentBlock, { type: "toolCall" }>;
  exec?: ToolExec;
  result?: PiMessage;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const args = (block.arguments ?? exec?.args ?? {}) as Record<string, unknown>;
  const fromMessage = result ? textOf(result.content) : "";
  const output =
    fromMessage ||
    (typeof exec?.result === "string"
      ? exec.result
      : exec?.result
        ? JSON.stringify(exec.result, null, 2)
        : "");
  const failed = Boolean(result?.isError || exec?.status === "error");
  const running = !failed && !output && (exec?.status === "running" || streaming);
  const diff = editsOf(args);
  const Icon = TOOL_ICONS[block.name] ?? WrenchIcon;
  const preview = toolPreview(block.name, args);

  return (
    <div className="group/tool">
      <button
        className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-[11px] text-muted-foreground hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon className="size-3 shrink-0 opacity-70" />
        <span className="shrink-0 font-medium text-foreground/75">{block.name}</span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate font-mono opacity-60">{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        {failed ? (
          <XIcon className="size-3 shrink-0 text-rose-500" />
        ) : running ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-emerald-600/60" />
        )}
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 opacity-0 transition group-hover/tool:opacity-50",
            open && "rotate-180 opacity-50",
          )}
        />
      </button>
      {open ? (
        <div className="my-1 ml-4 space-y-1.5 border-l pl-3">
          {diff ? (
            <FileDiff path={diff.path} pairs={diff.pairs} created={diff.created} />
          ) : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground/80">
              {JSON.stringify(args, null, 2).slice(0, 4000)}
            </pre>
          )}
          {output ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[10px]">
              {output.slice(0, 8000)}
            </pre>
          ) : null}
          {result?.details ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground/70">
              {typeof result.details === "string" ? result.details : JSON.stringify(result.details, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Compact thinking row: a single muted line unless expanded/streaming. */
function ThinkingRow({
  block,
  streaming,
}: {
  block: Extract<ContentBlock, { type: "thinking" }>;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || streaming;
  return (
    <div>
      <button
        className="flex h-6 items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <BrainIcon className="size-3 shrink-0 opacity-70" />
        <span>{streaming ? "思考中…" : "思考"}</span>
        <ChevronDownIcon className={cn("size-3 opacity-40 transition", expanded && "rotate-180")} />
      </button>
      {expanded && block.thinking.trim() ? (
        <div className="my-1 ml-4 max-h-40 overflow-auto whitespace-pre-wrap border-l pl-3 text-[11px] leading-5 text-muted-foreground/80">
          {block.thinking}
        </div>
      ) : null}
    </div>
  );
}

function Block({
  block,
  exec,
  result,
  streaming,
  last,
}: {
  block: ContentBlock;
  exec?: ToolExec;
  result?: PiMessage;
  streaming?: boolean;
  last?: boolean;
}) {
  if (block.type === "thinking") {
    if (!block.thinking.trim()) return null;
    return <ThinkingRow block={block} streaming={streaming} />;
  }
  if (block.type === "toolCall") {
    return <ToolRow block={block} exec={exec} result={result} streaming={streaming} />;
  }
  if (block.type === "text") {
    if (!block.text.trim()) return null;
    return (
      <MessageResponse
        className={cn("chat-md", last && streaming && "after:animate-pulse")}
        plugins={{ mermaid }}
        shikiTheme={["github-light", "github-dark-dimmed"]}
      >
        {block.text}
      </MessageResponse>
    );
  }
  if (block.type === "image") {
    return (
      <ZoomImage
        className="max-h-72 rounded-md border"
        src={`data:${block.mimeType};base64,${block.data}`}
      />
    );
  }
  return null;
}

const BADGES: Record<"plan" | "dualPlan" | "dualExec", string> = {
  plan: "计划模式",
  dualPlan: "规划阶段",
  dualExec: "执行阶段",
};

const UserMessage = memo(function UserMessage({
  message,
  onFork,
}: {
  message: PiMessage;
  onFork?: (message: PiMessage) => void;
}) {
  const raw = textOf(message.content);
  // 指令前缀（计划模式/双模型链）只进会话、不进展示：剥离后以徽章标注阶段
  const { kind, text } = stripDirective(raw);
  const badge = kind === "plain" ? null : BADGES[kind];
  const images = blocksOf(message).filter((b) => b.type === "image");
  return (
    <Message from="user">
      <MessageContent className="rounded-2xl bg-muted px-4 py-2.5">
        {badge ? (
          <span className="mb-1.5 inline-block rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            {badge}
          </span>
        ) : null}
        {text ? (
          <MessageResponse
            className="chat-md"
            plugins={{ mermaid }}
            shikiTheme={["github-light", "github-dark-dimmed"]}
          >
            {text}
          </MessageResponse>
        ) : null}
        {images.map((b, j) =>
          b.type === "image" ? (
            <ZoomImage
              className="max-h-72 rounded-md"
              key={j}
              src={`data:${b.mimeType};base64,${b.data}`}
            />
          ) : null,
        )}
      </MessageContent>
      <MessageActions className="justify-end opacity-0 transition-opacity group-hover:opacity-100">
        <CopyAction text={text} />
        {onFork ? (
          <MessageAction
            label="从这里分支"
            onClick={() => onFork(message)}
            tooltip="从这里分支：新会话保留此提问之前的历史，输入框预填该提问"
          >
            <GitForkIcon className="size-4" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </Message>
  );
});

const AssistantMessage = memo(
  AssistantMessageBase,
  (prev, next) => {
    if (prev.blocks !== next.blocks || prev.streaming !== next.streaming) return false;
    if (prev.onFork !== next.onFork) return false;
    for (const block of next.blocks) {
      if (block.type !== "toolCall") continue;
      if (prev.tools[block.id] !== next.tools[block.id]) return false;
      if (prev.results[block.id] !== next.results[block.id]) return false;
    }
    return true;
  },
);

function AssistantMessageBase({
  message,
  blocks,
  tools,
  results,
  streaming,
  onFork,
}: {
  message?: PiMessage;
  blocks: ContentBlock[];
  tools: Record<string, ToolExec>;
  results: Record<string, PiMessage>;
  streaming?: boolean;
  onFork?: (message: PiMessage) => void;
}) {
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  return (
    <Message from="assistant">
      <MessageContent className="gap-0.5">
        {blocks.map((block, i) => (
          <Block
            key={i}
            block={block}
            exec={block.type === "toolCall" ? tools[block.id] : undefined}
            result={block.type === "toolCall" ? results[block.id] : undefined}
            streaming={streaming}
            last={i === blocks.length - 1}
          />
        ))}
        {streaming && !text.trim() && !blocks.some((b) => b.type === "toolCall") ? <Loader /> : null}
      </MessageContent>
      {!streaming && text.trim() ? (
        <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
          <CopyAction text={text} />
          {onFork && message ? (
            <MessageAction
              label="从这里分支"
              onClick={() => onFork(message)}
              tooltip="从这里分支：新会话保留到此回复为止的历史"
            >
              <GitForkIcon className="size-4" />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null}
    </Message>
  );
}

/** Click to view an attachment full size. */
function ZoomImage({ src, className }: { src: string; className?: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <img
        alt="attachment"
        className={cn("cursor-zoom-in", className)}
        onClick={() => setZoom(true)}
        src={src}
      />
      {zoom ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-8"
          onClick={() => setZoom(false)}
        >
          <img alt="attachment" className="max-h-full max-w-full object-contain" src={src} />
        </div>
      ) : null}
    </>
  );
}

function CopyAction({ text }: { text: string }) {
  return (
    <MessageAction
      label="复制"
      tooltip="复制"
      onClick={() => navigator.clipboard.writeText(text)}
    >
      <CopyIcon className="size-4" />
    </MessageAction>
  );
}

function BashCard({ message }: { message: PiMessage }) {
  return (
    <div className="mb-2 rounded-md border">
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <TerminalIcon className="size-4 text-muted-foreground" />
        <code className="truncate font-mono text-xs">{message.command}</code>
        <span
          className={cn(
            "ml-auto font-mono text-xs",
            message.exitCode ? "text-destructive" : "text-muted-foreground",
          )}
        >
          exit {message.exitCode ?? 0}
        </span>
      </div>
      {message.output ? (
        <div className="border-t bg-muted/40">
          <CodeBlock code={message.output} language="bash">
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

const PAGE = 60;

export function Chat(props: { state: State; onFork?: (message: PiMessage) => void }) {
  const { state, onFork } = props;
  // Long sessions get one page at a time: the DOM stays small no matter how
  // many turns the transcript holds.
  const [limit, setLimit] = useState(PAGE);

  // toolResult messages live in the transcript but render inside their card.
  const results = useMemo(() => {
    const map: Record<string, PiMessage> = {};
    for (const m of state.messages) {
      if (m.role === "toolResult" && m.toolCallId) map[m.toolCallId] = m;
    }
    return map;
  }, [state.messages]);

  const visible = state.messages.filter(
    (m) => m.role !== "toolResult" && m.role !== "system" && m.role !== "bashExecution",
  );
  const start = Math.max(0, visible.length - limit);
  const windowed = visible.slice(start);

  return (
    <Conversation>
      <ConversationContent className="mx-auto w-full max-w-3xl gap-2 px-5 py-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-[1800px]:max-w-7xl">
        {visible.length === 0 && !state.streaming ? (
          <ConversationEmptyState
            title="开始对话"
            description={`工作目录 ${state.cwd || "~"}`}
          />
        ) : null}

        {start > 0 ? (
          <button
            className="mx-auto rounded-md border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setLimit((n) => n + PAGE)}
            type="button"
          >
            加载更早的 {Math.min(start, PAGE)} 条消息（共 {visible.length} 条）
          </button>
        ) : null}

        {windowed.map((message, i) => {
          if (message.role === "user") {
            return <UserMessage key={start + i} message={message} onFork={onFork} />;
          }
          if (message.role === "assistant") {
            return (
              <AssistantMessage
                key={start + i}
                blocks={blocksOf(message)}
                message={message}
                onFork={onFork}
                results={results}
                tools={state.tools}
              />
            );
          }
          if (message.role === "compactionSummary" || message.role === "branchSummary") {
            return (
              <div key={i} className="flex items-center gap-3 text-muted-foreground text-xs">
                <div className="h-px flex-1 bg-border" />
                {message.role === "compactionSummary" ? "上下文已压缩" : "分支摘要"}
                <div className="h-px flex-1 bg-border" />
              </div>
            );
          }
          if (message.role === "bashExecution") return <BashCard key={i} message={message} />;
          return null;
        })}

        {state.messages
          .filter((m) => m.role === "bashExecution")
          .slice(-1)
          .map((m, i) => (state.isStreaming ? <BashCard key={`bash-${i}`} message={m} /> : null))}

        {state.streaming ? (
          <AssistantMessage
            blocks={state.streaming}
            tools={state.tools}
            results={results}
            streaming
          />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
