import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mermaid } from "@streamdown/mermaid";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { stripAttachmentBlocks, stripDirective, stripImageNotes, stripSkillBlock } from "@/lib/promptPrefixes";
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
        data-thinking-toggle={streaming ? "live" : "idle"}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span>{streaming ? "思考中…" : "思考"}</span>
        <ChevronDownIcon className={cn("size-3.5 transition", expanded && "rotate-180")} />
      </button>
      {expanded && block.thinking.trim() ? (
        <div
          className="my-1 ml-4 max-h-40 overflow-auto whitespace-pre-wrap border-l pl-3 text-xs leading-6 text-muted-foreground"
          data-thinking-body
        >
          {block.thinking}
        </div>
      ) : null}
    </div>
  );
}

// 流式 markdown 的解析/高亮成本随文本长度线性增长：把"正在写的最后一块"按
// 60ms 节流（文本本身仍按 16ms 批量更新），并且流式期间关闭 shiki 高亮——
// 代码块等回合结束后一次性着色，避免每帧重新高亮。
function useThrottledText(text: string, active: boolean, ms = 60) {
  const [value, setValue] = useState(text);
  const lastAt = useRef(0);
  useEffect(() => {
    if (!active) {
      setValue(text);
      lastAt.current = Date.now();
      return;
    }
    const elapsed = Date.now() - lastAt.current;
    if (elapsed >= ms) {
      setValue(text);
      lastAt.current = Date.now();
      return;
    }
    const timer = setTimeout(() => {
      setValue(text);
      lastAt.current = Date.now();
    }, ms - elapsed);
    return () => clearTimeout(timer);
  }, [text, active, ms]);
  return active ? value : text;
}

function Block({
  block,
  exec,
  result,
  streaming,
  thinkingLive,
  last,
}: {
  block: ContentBlock;
  exec?: ToolExec;
  result?: PiMessage;
  streaming?: boolean;
  // 只有"当前正在吐字"的那条思考自动展开；已结束的思考行保持收起，
  // 否则回合里每条思考都会跟着新 delta 一起弹开再一起收回去。
  thinkingLive?: boolean;
  last?: boolean;
}) {
  // hook 必须无条件调用（block 类型可能从 text 变成 toolCall）
  const liveText = Boolean(last && streaming);
  const shownText = useThrottledText(block.type === "text" ? block.text : "", liveText);
  if (block.type === "thinking") {
    if (!block.thinking.trim()) return null;
    return <ThinkingRow block={block} streaming={thinkingLive} />;
  }
  if (block.type === "toolCall") {
    return <ToolRow block={block} exec={exec} result={result} streaming={streaming} />;
  }
  if (block.type === "text") {
    if (!block.text.trim()) return null;
    return (
      <MessageResponse
        className={cn("chat-md", liveText && "after:animate-pulse")}
        plugins={{ mermaid }}
        shikiTheme={liveText ? undefined : ["github-light", "github-dark-dimmed"]}
      >
        {shownText}
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
  // 附件解析正文同样只给模型：气泡里只留用户自己写的话（附件由 chip 承载）
  const cleaned = stripAttachmentBlocks(stripImageNotes(stripped));
  // `/skill:name` 展开的整篇 SKILL.md 正文也不上屏：只留参数，技能名做徽章
  const { name: skillName, text } = stripSkillBlock(cleaned);
  const badge = skillName ? `技能 · ${skillName}` : kind === "plain" ? null : BADGES[kind];
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
  active,
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
  // 回合仍在进行（chat 级 isStreaming）：工作过程保持展开，结束后才折叠
  active?: boolean;
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
  // 回合进行中始终展开；结束后折叠成一行（用户可再点开）
  const showWork = active || streaming || workOpen;
  // 流式中每秒刷新一次已工作时长
  const [tick, setTick] = useState(0);
  const running = Boolean(active || streaming);
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  const live = running && startedAt ? Date.now() - startedAt : undefined;
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
            disabled={running}
            onClick={() => setWorkOpen((v) => !v)}
            title={running ? "执行过程（回合进行中）" : workOpen ? "收起执行过程" : "展开执行过程（思考与工具调用）"}
            type="button"
          >
            <Clock3Icon className="size-3 shrink-0" />
            <span>
              {running ? "正在工作 " : "已工作 "}
              {fmtDuration(elapsed) ?? `${workBlocks.length} 步`}
            </span>
            {running ? (
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
                thinkingLive={streaming && block === blocks[blocks.length - 1]}
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

// 一个回合里 pi 会产生多条 assistant 消息（每次工具调用一轮），逐条渲染会出
// 一长串「已工作 N 秒」。这里按回合合并成一行；同时作为虚拟列表的 row model。
type TurnRow =
  | { kind: "user"; key: string; message: PiMessage }
  | {
      kind: "assistant";
      key: string;
      blocks: ContentBlock[];
      atTail: boolean;
      liveTail: boolean;
      durationMs?: number;
      startedAt?: number;
      message: PiMessage;
    }
  | { kind: "summary"; key: string; role: "compactionSummary" | "branchSummary" }
  | { kind: "bash"; key: string; message: PiMessage }
  | { kind: "live"; key: "live"; startedAt?: number };

/** 主聊天与并行会话共用的转录视图：虚拟化消息流 + 流式块 + 等待占位。 */
export function Transcript(props: {
  messages: PiMessage[];
  streaming: ContentBlock[] | null;
  isStreaming: boolean;
  tools: Record<string, ToolExec>;
  cwd: string;
  loading?: boolean;
  onFork?: (message: PiMessage) => void;
}) {
  return (
    <Conversation>
      {/* body 必须在 StickToBottom 的 provider 内：虚拟列表要拿 scrollRef */}
      <TranscriptBody {...props} />
      <ConversationScrollButton />
    </Conversation>
  );
}

function TranscriptBody({
  messages,
  streaming,
  isStreaming,
  tools,
  cwd,
  loading = false,
  onFork,
}: {
  messages: PiMessage[];
  streaming: ContentBlock[] | null;
  isStreaming: boolean;
  tools: Record<string, ToolExec>;
  cwd: string;
  loading?: boolean;
  onFork?: (message: PiMessage) => void;
}) {
  const resolveAttachments = useSavedAttachments(cwd);
  const { scrollRef } = useStickToBottomContext();

  // toolResult messages live in the transcript but render inside their card.
  const results = useMemo(() => {
    const map: Record<string, PiMessage> = {};
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) map[m.toolCallId] = m;
    }
    return map;
  }, [messages]);

  const streamingStarted = Boolean(streaming && streaming.length > 0);
  // 回合是否仍在进行：用 chat 级 isStreaming（跨工具轮保持 true），
  // 而不是瞬时的 streaming 块（工具轮之间会短暂为 null，导致反复折叠）
  const rows = useMemo<TurnRow[]>(() => {
    const out: TurnRow[] = [];
    const visible = messages.filter(
      (m) => m.role !== "toolResult" && m.role !== "system" && m.role !== "bashExecution",
    );
    let lastUserTs: number | undefined;
    let i = 0;
    while (i < visible.length) {
      const message = visible[i];
      if (message.role === "user") {
        if (message.timestamp) lastUserTs = message.timestamp;
        out.push({ kind: "user", key: `u-${i}`, message });
        i += 1;
        continue;
      }
      if (message.role === "assistant") {
        const group: PiMessage[] = [message];
        let j = i + 1;
        while (j < visible.length && visible[j].role === "assistant") {
          group.push(visible[j]);
          j += 1;
        }
        const atTail = j === visible.length;
        const lastMsg = group[group.length - 1];
        const liveTail = atTail && isStreaming;
        out.push({
          kind: "assistant",
          key: `a-${i}`,
          blocks: group.flatMap((m) => blocksOf(m)),
          atTail,
          liveTail,
          durationMs:
            !liveTail && lastMsg.timestamp && lastUserTs
              ? lastMsg.timestamp - lastUserTs
              : undefined,
          startedAt: lastUserTs,
          message: lastMsg,
        });
        i = j;
        continue;
      }
      if (message.role === "compactionSummary" || message.role === "branchSummary") {
        out.push({ kind: "summary", key: `s-${i}`, role: message.role });
        i += 1;
        continue;
      }
      i += 1;
    }
    // 还没有任何 assistant 消息的回合（首个工具轮之前）
    if (streamingStarted && (out.length === 0 || out[out.length - 1]?.kind === "user")) {
      out.push({ kind: "live", key: "live", startedAt: lastUserTs });
    }
    return out;
  }, [messages, isStreaming, streamingStarted]);

  const renderRow = (row: TurnRow): React.ReactNode => {
    switch (row.kind) {
      case "user":
        return (
          <UserMessage
            files={resolveAttachments(row.message.timestamp)}
            message={row.message}
            onFork={onFork}
          />
        );
      case "assistant":
        return (
          <AssistantMessage
            active={row.liveTail}
            blocks={row.liveTail ? [...row.blocks, ...(streaming ?? [])] : row.blocks}
            durationMs={row.durationMs}
            message={row.message}
            onFork={onFork}
            results={results}
            startedAt={row.liveTail ? row.startedAt : undefined}
            streaming={row.atTail && Boolean(streaming)}
            tools={tools}
          />
        );
      case "summary":
        return (
          <div className="flex items-center gap-3 text-muted-foreground text-xs">
            <div className="h-px flex-1 bg-border" />
            {row.role === "compactionSummary" ? "上下文已压缩" : "分支摘要"}
            <div className="h-px flex-1 bg-border" />
          </div>
        );
      case "bash":
        return <BashCard message={row.message} />;
      case "live":
        return (
          <AssistantMessage
            active
            blocks={streaming ?? []}
            results={results}
            startedAt={row.startedAt}
            streaming
            tools={tools}
          />
        );
    }
  };

  // 只挂可视区附近的行（opencode 同款虚拟化）：React 渲染 + shiki 高亮
  // 与历史长度解耦；动态测高由 measureElement + ResizeObserver 完成。
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    overscan: 6,
    getItemKey: (index) => rows[index].key,
  });

  const showEmpty = rows.length === 0 && !isStreaming && !loading;

  return (
    <ConversationContent className="mx-auto w-full max-w-3xl gap-2 px-5 py-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-[1800px]:max-w-7xl">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            正在打开会话…
          </div>
        ) : null}

        {showEmpty ? (
          <ConversationEmptyState
            title="开始对话"
            description={`工作目录 ${cwd || "~"}`}
          />
        ) : null}

        {rows.length > 0 ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                className="absolute left-0 top-0 w-full pb-2"
                data-chat-node={rows[item.index].key}
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(rows[item.index])}
              </div>
            ))}
          </div>
        ) : null}

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
  );
}

/** 主聊天视图：完整会话状态包一层 Transcript。 */
export function Chat(props: { state: State; onFork?: (message: PiMessage) => void }) {
  const { state, onFork } = props;
  return (
    <Transcript
      // 会话切换要重置分页状态与滚动位置（否则上一会话的 limit 会带过来）
      key={state.sessionFile ?? ""}
      cwd={state.cwd}
      isStreaming={state.isStreaming}
      loading={state.loadingSession}
      messages={state.messages}
      onFork={onFork}
      streaming={state.streaming}
      tools={state.tools}
    />
  );
}
