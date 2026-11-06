import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { mermaid } from "@streamdown/mermaid";
import { stripDirective, stripImageNotes } from "@/lib/promptPrefixes";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  Clock3Icon,
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
  const { kind, text: stripped } = stripDirective(raw);
  // 去掉 pi 追加的图片尺寸提示（[Image: original …]），那是给模型看的
  const text = stripImageNotes(stripped);
  const badge = kind === "plain" ? null : BADGES[kind];
  const images = blocksOf(message).filter((b) => b.type === "image");
  return (
    <Message from="user">
      {/* 图片放气泡外、右对齐（气泡只装文字，避免宽图把气泡撑出大片空白） */}
      {images.length ? (
        // 单图：自然比例（可读）；多图：等尺寸方格（曾有不同长宽比导致拼接错位）
        images.length === 1 ? (
          <div className="ml-auto w-fit">
            {images.map((b, j) =>
              b.type === "image" ? (
                <ZoomImage
                  className="max-h-56 w-auto max-w-[320px] rounded-xl border border-border/60 object-contain"
                  key={j}
                  src={`data:${b.mimeType};base64,${b.data}`}
                />
              ) : null,
            )}
          </div>
        ) : (
          // 按行列分组、每行独立右对齐：4 张用 2×2，其余每行 3 张。
          // 单用 grid-cols-3 时最后一行不满会靠左，视觉上歪
          <div className="ml-auto flex w-fit flex-col items-end gap-1.5">
            {chunkImages(images, images.length === 4 ? 2 : 3).map((row, r) => (
              <div className="flex justify-end gap-1.5" key={r}>
                {row.map((b, j) =>
                  b.type === "image" ? (
                    <ZoomImage
                      className="size-28 rounded-lg border border-border/60 object-cover"
                      key={j}
                      src={`data:${b.mimeType};base64,${b.data}`}
                    />
                  ) : null,
                )}
              </div>
            ))}
          </div>
        )
      ) : null}
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
    if (prev.durationMs !== next.durationMs) return false;
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
  durationMs,
  startedAt,
}: {
  message?: PiMessage;
  blocks: ContentBlock[];
  tools: Record<string, ToolExec>;
  results: Record<string, PiMessage>;
  streaming?: boolean;
  onFork?: (message: PiMessage) => void;
  // 本回合耗时（user 消息 → 本条回复），完成后显示为「已工作 N 秒」
  durationMs?: number;
  // 回合开始时间（流式中据此实时计时）
  startedAt?: number;
}) {
  const text = stripImageNotes(
    blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );

  // 工作过程（思考 + 工具调用）在回合结束后折叠成一行，让用户先看到结论；
  // 流式中保持展开，执行细节仍然实时可见。
  const workBlocks = blocks.filter((b) => b.type === "thinking" || b.type === "toolCall");
  const textBlocks = blocks.filter((b) => b.type !== "thinking" && b.type !== "toolCall");
  const [workOpen, setWorkOpen] = useState(false);
  const showWork = streaming || workOpen;
  // 流式中每秒刷新一次已工作时长
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming || !startedAt) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [streaming, startedAt]);
  const live = streaming && startedAt ? Date.now() - startedAt : undefined;
  void tick;
  const elapsed = live ?? durationMs;
  const fmtDuration = (ms?: number) => {
    if (!ms || ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    return `${m} 分 ${s % 60} 秒`;
  };

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
        {workBlocks.length > 0 ? (
          <button
            className="mb-0.5 flex w-fit items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-default"
            disabled={streaming}
            onClick={() => setWorkOpen((v) => !v)}
            title={streaming ? "执行过程（流式中）" : workOpen ? "收起执行过程" : "展开执行过程（思考与工具调用）"}
            type="button"
          >
            <Clock3Icon className="size-3 shrink-0" />
            <span>
              {streaming ? "正在工作 " : "已工作 "}
              {fmtDuration(elapsed) ?? `${workBlocks.length} 步`}
            </span>
            {streaming ? (
              <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground/70" />
            ) : (
              <ChevronDownIcon
                className={cn("size-3 shrink-0 transition-transform", workOpen && "rotate-180")}
              />
            )}
          </button>
        ) : null}

        {showWork
          ? workBlocks.map((block, i) => (
              <Block
                key={`work-${i}`}
                block={block}
                exec={block.type === "toolCall" ? tools[block.id] : undefined}
                result={block.type === "toolCall" ? results[block.id] : undefined}
                streaming={streaming}
                last={i === workBlocks.length - 1}
              />
            ))
          : null}

        {textBlocks.map((block, i) => (
          <Block
            key={`text-${i}`}
            block={block}
            exec={undefined}
            result={undefined}
            streaming={streaming}
            last={i === textBlocks.length - 1}
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

// 按每行容量切分图片（多图排版的最后一行要单独右对齐）
const chunkImages = <T,>(list: T[], perRow: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / perRow) }, (_, i) =>
    list.slice(i * perRow, (i + 1) * perRow),
  );

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

        {(() => {
          // 一个回合里 pi 会产生多条 assistant 消息（每次工具调用一轮），
          // 逐条渲染会出现一长串「已工作 N 秒」。这里把同一回合的连续
          // assistant 消息合并成一个段落：一条耗时条 + 合并后的思考/工具/正文。
          const nodes: { key: string; node: React.ReactNode }[] = [];
          let lastUserTs: number | undefined;
          let i = 0;
          while (i < windowed.length) {
            const message = windowed[i];
            if (message.role === "user") {
              if (message.timestamp) lastUserTs = message.timestamp;
              nodes.push({
                key: `u-${start + i}`,
                node: (
                  <UserMessage
                    files={resolveAttachments(message.timestamp)}
                    message={message}
                    onFork={onFork}
                  />
                ),
              });
              i += 1;
              continue;
            }
            if (message.role === "assistant") {
              const group: PiMessage[] = [message];
              let j = i + 1;
              while (j < windowed.length && windowed[j].role === "assistant") {
                group.push(windowed[j]);
                j += 1;
              }
              const atTail = j === windowed.length;
              // 流式内容属于同一回合：并进最后一段并标记 streaming
              const withLive = atTail && Boolean(streaming);
              const mergedBlocks = group.flatMap((m) => blocksOf(m));
              const lastMsg = group[group.length - 1];
              nodes.push({
                key: `a-${start + i}`,
                node: (
                  <AssistantMessage
                    blocks={withLive ? [...mergedBlocks, ...(streaming ?? [])] : mergedBlocks}
                    durationMs={
                      !withLive && lastMsg.timestamp && lastUserTs
                        ? lastMsg.timestamp - lastUserTs
                        : undefined
                    }
                    message={lastMsg}
                    onFork={onFork}
                    results={results}
                    startedAt={withLive ? lastUserTs : undefined}
                    streaming={withLive}
                    tools={tools}
                  />
                ),
              });
              i = j;
              continue;
            }
            if (message.role === "compactionSummary" || message.role === "branchSummary") {
              nodes.push({
                key: `s-${start + i}`,
                node: (
                  <div className="flex items-center gap-3 text-muted-foreground text-xs">
                    <div className="h-px flex-1 bg-border" />
                    {message.role === "compactionSummary" ? "上下文已压缩" : "分支摘要"}
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ),
              });
              i += 1;
              continue;
            }
            if (message.role === "bashExecution") {
              nodes.push({ key: `b-${start + i}`, node: <BashCard message={message} /> });
            }
            i += 1;
          }
          // 还没有任何 assistant 消息的回合（首个工具轮之前）
          if (streaming && (nodes.length === 0 || windowed[windowed.length - 1]?.role === "user")) {
            nodes.push({
              key: "live",
              node: (
                <AssistantMessage
                  blocks={streaming}
                  results={results}
                  startedAt={lastUserTs}
                  streaming
                  tools={tools}
                />
              ),
            });
          }
          return nodes.map((n) => <Fragment key={n.key}>{n.node}</Fragment>);
        })()}

        {messages
          .filter((m) => m.role === "bashExecution")
          .slice(-1)
          .map((m, i) => (isStreaming ? <BashCard key={`bash-${i}`} message={m} /> : null))}

        {/* 等待首字：prompt 已被接受但模型还没有任何输出（联网/排队/思考），
            给一个带秒数的占位行，否则这段时间界面完全静默 */}
        {isStreaming && (!streaming || streaming.length === 0) ? (
          <WaitingRow />
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
