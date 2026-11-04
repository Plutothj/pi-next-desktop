import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { mermaid } from "@streamdown/mermaid";
import { stripDirective } from "@/lib/promptPrefixes";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FilePenLineIcon,
  FileTextIcon,
  PaperclipIcon,
  GitForkIcon,
  Loader2Icon,
  PencilLineIcon,
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
        className="flex h-7 w-full items-center gap-1.5 rounded px-1 text-left text-xs text-muted-foreground hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground/80">{block.name}</span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate font-mono">{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        {failed ? (
          <XIcon className="size-3.5 shrink-0 text-rose-500" />
        ) : running ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-600/70" />
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-0 transition group-hover/tool:opacity-60",
            open && "rotate-180 opacity-60",
          )}
        />
      </button>
      {open ? (
        <div className="my-1 ml-4 space-y-1.5 border-l pl-3">
          {diff ? (
            <FileDiff path={diff.path} pairs={diff.pairs} created={diff.created} />
          ) : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {JSON.stringify(args, null, 2).slice(0, 4000)}
            </pre>
          )}
          {output ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-xs">
              {output.slice(0, 8000)}
            </pre>
          ) : null}
          {result?.details ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {typeof result.details === "string" ? result.details : JSON.stringify(result.details, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 等待首字占位：联网 / 排队 / 等待模型首个 token，秒数让"没卡死"可见。 */
function WaitingRow() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      <span>正在等待模型响应…</span>
      {elapsed >= 3 ? (
        <span className="text-muted-foreground/60">{elapsed}s</span>
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
        className="flex h-7 items-center gap-1.5 rounded px-1 text-xs text-muted-foreground hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span>{streaming ? "思考中…" : "思考"}</span>
        <ChevronDownIcon className={cn("size-3.5 transition", expanded && "rotate-180")} />
      </button>
      {expanded && block.thinking.trim() ? (
        <div className="my-1 ml-4 max-h-40 overflow-auto whitespace-pre-wrap border-l pl-3 text-xs leading-6 text-muted-foreground">
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

// 已落盘附件的索引：按消息时间戳就近匹配（附件在发送前落盘，与 pi 记录的
// user 消息 timestamp 相差几百毫秒内）。发送/索引变化通过 window 事件刷新。
type SavedFile = { name: string; path: string; kind: string };
type AttachmentRecord = { ts: number; files: SavedFile[] };
const ATTACH_TOLERANCE_MS = 10_000;

function useSavedAttachments(cwd: string) {
  const [records, setRecords] = useState<AttachmentRecord[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      window.pi
        .listAttachments(cwd)
        .then((list) => {
          if (alive) setRecords(list);
        })
        .catch(() => null);
    };
    load();
    window.addEventListener("pi:attachments-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("pi:attachments-changed", load);
    };
  }, [cwd]);

  return useCallback(
    (ts?: number): SavedFile[] => {
      if (!ts) return [];
      let best: AttachmentRecord | null = null;
      for (const r of records) {
        const d = Math.abs(r.ts - ts);
        if (d > ATTACH_TOLERANCE_MS) continue;
        if (!best || d < Math.abs(best.ts - ts)) best = r;
      }
      return best?.files ?? [];
    },
    [records],
  );
}

/** 聊天里的附件 chip：点击派发到 App → 右侧预览面板加载该文件 */
function AttachmentChips({ files }: { files: SavedFile[] }) {
  if (!files.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <button
          className="flex max-w-56 items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          key={file.path}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("pi:preview-file", { detail: { abs: file.path, name: file.name } }),
            )
          }
          title={`点击预览：${file.path}`}
          type="button"
        >
          <PaperclipIcon className="size-3 shrink-0" />
          <span className="truncate">{file.name}</span>
        </button>
      ))}
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  files,
  message,
  onFork,
}: {
  files?: SavedFile[];
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
          <span className="mb-1.5 inline-block rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {badge}
          </span>
        ) : null}
        <AttachmentChips files={files ?? []} />
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
            label="编辑重发"
            onClick={() => onFork(message)}
            tooltip="编辑重发：截断此提问之后的内容，输入框预填原文供修改后重新发送"
          >
            <PencilLineIcon className="size-4" />
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
        {/* 回合级错误（429 限流 / 网络断 / 模型暂停等）：pi 返回空 content +
            stopReason=error + errorMessage，之前完全静默。 */}
        {message?.stopReason === "error" ? (
          <div className="mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
            <span className="font-medium text-destructive">模型请求失败</span>
            <p className="mt-0.5 leading-5 text-muted-foreground">
              {message.errorMessage ?? "未知错误（可能是网络中断或供应商限流）"}
            </p>
          </div>
        ) : null}
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

/** 主聊天与并行会话共用的转录视图：消息流 + 流式块 + 等待占位。 */
export function Transcript({
  messages,
  streaming,
  isStreaming,
  tools,
  cwd,
  onFork,
}: {
  messages: PiMessage[];
  streaming: ContentBlock[] | null;
  isStreaming: boolean;
  tools: Record<string, ToolExec>;
  cwd: string;
  onFork?: (message: PiMessage) => void;
}) {
  // Long sessions get one page at a time: the DOM stays small no matter how
  // many turns the transcript holds.
  const [limit, setLimit] = useState(PAGE);
  const resolveAttachments = useSavedAttachments(cwd);

  // toolResult messages live in the transcript but render inside their card.
  const results = useMemo(() => {
    const map: Record<string, PiMessage> = {};
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) map[m.toolCallId] = m;
    }
    return map;
  }, [messages]);

  const visible = messages.filter(
    (m) => m.role !== "toolResult" && m.role !== "system" && m.role !== "bashExecution",
  );
  const start = Math.max(0, visible.length - limit);
  const windowed = visible.slice(start);

  return (
    <Conversation>
      <ConversationContent className="mx-auto w-full max-w-3xl gap-2 px-5 py-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-[1800px]:max-w-7xl">
        {visible.length === 0 && !streaming ? (
          <ConversationEmptyState
            title="开始对话"
            description={`工作目录 ${cwd || "~"}`}
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
            return (
              <UserMessage
                files={resolveAttachments(message.timestamp)}
                key={start + i}
                message={message}
                onFork={onFork}
              />
            );
          }
          if (message.role === "assistant") {
            return (
              <AssistantMessage
                key={start + i}
                blocks={blocksOf(message)}
                message={message}
                onFork={onFork}
                results={results}
                tools={tools}
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

        {messages
          .filter((m) => m.role === "bashExecution")
          .slice(-1)
          .map((m, i) => (isStreaming ? <BashCard key={`bash-${i}`} message={m} /> : null))}

        {/* 等待首字：prompt 已被接受但模型还没有任何输出（联网/排队/思考），
            给一个带秒数的占位行，否则这段时间界面完全静默 */}
        {isStreaming && (!streaming || streaming.length === 0) ? (
          <WaitingRow />
        ) : null}

        {streaming ? (
          <AssistantMessage
            blocks={streaming}
            tools={tools}
            results={results}
            streaming
          />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

/** 主聊天视图：完整会话状态包一层 Transcript。 */
export function Chat(props: { state: State; onFork?: (message: PiMessage) => void }) {
  const { state, onFork } = props;
  return (
    <Transcript
      cwd={state.cwd}
      isStreaming={state.isStreaming}
      messages={state.messages}
      onFork={onFork}
      streaming={state.streaming}
      tools={state.tools}
    />
  );
}
