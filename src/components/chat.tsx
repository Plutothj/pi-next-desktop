import { memo, useMemo, useState } from "react";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
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
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { FileDiff, editsOf } from "@/components/file-diff";
import { blocksOf, textOf, type ContentBlock, type PiMessage, type ToolExec } from "@/lib/pi";
import type { State } from "@/hooks/usePi";

type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

function ToolCard({
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
  const args = block.arguments ?? exec?.args ?? {};
  const fromMessage = result ? textOf(result.content) : "";
  const output =
    fromMessage ||
    (typeof exec?.result === "string"
      ? exec.result
      : exec?.result
        ? JSON.stringify(exec.result, null, 2)
        : undefined);
  const failed = result?.isError || exec?.status === "error";
  const diff = editsOf(args as Record<string, unknown>);
  const details = result?.details;

  const state: ToolState = failed
    ? "output-error"
    : output !== undefined
      ? "output-available"
      : exec || streaming
        ? "input-available"
        : "input-streaming";

  return (
    <Tool defaultOpen={Boolean(diff)}>
      <ToolHeader title={block.name} type={`tool-${block.name}` as never} state={state} />
      <ToolContent>
        {diff ? (
          <FileDiff path={diff.path} pairs={diff.pairs} created={diff.created} />
        ) : (
          <ToolInput input={args} />
        )}
        {!diff ? (
          <ToolOutput output={output} errorText={failed ? (output ?? "执行失败") : undefined} />
        ) : null}
        {diff && output ? (
          <div className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {output.slice(0, 4000)}
          </div>
        ) : null}
        {details ? (
          <div className="space-y-2 p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              详情
            </h4>
            <CodeBlock
              code={typeof details === "string" ? details : JSON.stringify(details, null, 2)}
              language="json"
            >
              <CodeBlockCopyButton />
            </CodeBlock>
          </div>
        ) : null}
      </ToolContent>
    </Tool>
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
    return (
      <Reasoning isStreaming={streaming} defaultOpen={false}>
        <ReasoningTrigger
          getThinkingMessage={(isStreaming, duration) =>
            isStreaming || !duration ? "思考中…" : `思考了 ${duration} 秒`
          }
        />
        <ReasoningContent>{block.thinking}</ReasoningContent>
      </Reasoning>
    );
  }
  if (block.type === "toolCall") {
    return <ToolCard block={block} exec={exec} result={result} streaming={streaming} />;
  }
  if (block.type === "text") {
    if (!block.text.trim()) return null;
    return (
      <MessageResponse className={cn(last && streaming && "after:animate-pulse")} plugins={{ mermaid }}>
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

const UserMessage = memo(function UserMessage({ message }: { message: PiMessage }) {
  const text = textOf(message.content);
  const images = blocksOf(message).filter((b) => b.type === "image");
  return (
    <Message from="user">
      <MessageContent className="rounded-2xl bg-muted px-4 py-2.5">
        {text ? <MessageResponse plugins={{ mermaid }}>{text}</MessageResponse> : null}
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
    </Message>
  );
});

const AssistantMessage = memo(
  AssistantMessageBase,
  (prev, next) => {
    if (prev.blocks !== next.blocks || prev.streaming !== next.streaming) return false;
    for (const block of next.blocks) {
      if (block.type !== "toolCall") continue;
      if (prev.tools[block.id] !== next.tools[block.id]) return false;
      if (prev.results[block.id] !== next.results[block.id]) return false;
    }
    return true;
  },
);

function AssistantMessageBase({
  blocks,
  tools,
  results,
  streaming,
}: {
  blocks: ContentBlock[];
  tools: Record<string, ToolExec>;
  results: Record<string, PiMessage>;
  streaming?: boolean;
}) {
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  return (
    <Message from="assistant">
      <MessageContent className="gap-1.5">
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

export function Chat(props: { state: State }) {
  const { state } = props;
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
      <ConversationContent className="mx-auto w-full max-w-3xl gap-3 px-5 py-4">
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
            return <UserMessage key={start + i} message={message} />;
          }
          if (message.role === "assistant") {
            return (
              <AssistantMessage
                key={start + i}
                blocks={blocksOf(message)}
                tools={state.tools}
                results={results}
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
