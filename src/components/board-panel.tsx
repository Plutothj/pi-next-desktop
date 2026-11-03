// 并行会话面板：同一/不同工作区下开多个活会话同时对话。
// 列表视图派发新会话；点进任一会话是完整实时对话视图（可追问、可插话、
// 可中断），各会话独立 pi 进程、互不影响。
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, Loader2Icon, RocketIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Transcript } from "@/components/chat";
import { useBoardSessions } from "@/hooks/useBoardSessions";
import { cn } from "@/lib/utils";
import type { BoardAgent } from "@/lib/pi";

const statusLabel = {
  running: "运行中",
  done: "已完成",
  failed: "已停止",
  error: "启动失败",
} as const;

export function BoardPanel({
  cwd,
  onPromote,
}: {
  cwd: string;
  onPromote: (sessionFile: string, cwd?: string) => void;
}) {
  const [agents, setAgents] = useState<BoardAgent[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sessions = useBoardSessions();

  useEffect(() => {
    window.pi.board.list().then(setAgents).catch(() => {});
    return window.pi.onEvent((rec) => {
      if (rec.type === "agent_update" && rec.agent) {
        setAgents((prev) => {
          const next = prev.filter((a) => a.id !== rec.agent!.id);
          return [...next, rec.agent!].slice(-30);
        });
      }
    });
  }, []);

  const launch = async () => {
    if (!message.trim()) return;
    setBusy(true);
    const created = await window.pi.board
      .run({ name: name.trim() || undefined, cwd, message: message.trim() })
      .catch(() => null);
    setBusy(false);
    setMessage("");
    window.pi.board.list().then(setAgents).catch(() => {});
    if (created?.id) setOpenId(created.id); // 立即进入该会话看实时输出
  };

  const openAgent = agents.find((a) => a.id === openId) ?? null;

  // ---------------------------------------------------------------- 会话视图
  if (openAgent) {
    const view = sessions[openAgent.id];
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Button
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setOpenId(null)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-3.5" />
            列表
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{openAgent.name}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
              openAgent.status === "running"
                ? "bg-amber-500/15 text-amber-600"
                : openAgent.status === "done"
                  ? "bg-emerald-500/15 text-emerald-600"
                  : "bg-rose-500/15 text-rose-600",
            )}
          >
            {statusLabel[openAgent.status]}
          </span>
          {openAgent.sessionFile && openAgent.status !== "running" ? (
            <Button
              className="h-7 px-2 text-[11px]"
              onClick={() => onPromote(openAgent.sessionFile!, openAgent.cwd)}
              size="sm"
              variant="outline"
            >
              主界面打开
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {view && view.messages.length + (view.streaming?.length ?? 0) > 0 ? (
            <Transcript
              cwd={openAgent.cwd}
              isStreaming={view.isStreaming}
              messages={view.messages}
              streaming={view.streaming}
              tools={view.tools}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              会话启动中…
            </div>
          )}
        </div>

        <AgentComposer agent={openAgent} />
      </div>
    );
  }

  // ---------------------------------------------------------------- 列表视图
  const running = agents.filter((a) => a.status === "running").length;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="space-y-2 rounded-xl border bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RocketIcon className="size-3.5" />
          新建并行会话
          <span className="ml-auto">{running ? `${running} 个运行中` : ""}</span>
        </div>
        <Input
          className="h-8 text-xs"
          onChange={(e) => setName(e.target.value)}
          placeholder="会话名（可选），如：审查 PR"
          value={name}
        />
        <Textarea
          className="min-h-16 text-xs"
          onChange={(e) => setMessage(e.target.value)}
          placeholder="要做的事。它会在独立会话里自己干，你可以随时点进去接着聊。"
          value={message}
        />
        <Button
          className="h-7 w-full gap-1.5 text-xs"
          disabled={busy || !message.trim()}
          onClick={launch}
          size="sm"
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <RocketIcon className="size-3" />}
          新建（{cwd.split(/[\\/]/).pop() || cwd}）
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto">
        {agents.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">
            还没有并行会话。开一个，你继续聊你的。
          </p>
        ) : null}
        {[...agents].reverse().map((a) => (
          <button
            className="w-full rounded-xl border bg-card/40 p-3 text-left transition-colors hover:border-primary/40"
            key={a.id}
            onClick={() => setOpenId(a.id)}
            type="button"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  a.status === "running" && "animate-pulse bg-amber-500",
                  a.status === "done" && "bg-emerald-500",
                  (a.status === "failed" || a.status === "error") && "bg-rose-500",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {statusLabel[a.status]}
              </span>
            </div>
            {a.tail ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                {a.tail}
              </p>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 活会话输入框：空闲发新消息；流式中 Enter 排队、Option+Enter 插话。 */
function AgentComposer({ agent }: { agent: BoardAgent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    await window.pi.board.message(agent.id, value).catch(() => null);
    setSending(false);
    setText("");
    inputRef.current?.focus();
  };

  const streaming = agent.status === "running";

  return (
    <div className="shrink-0 border-t p-2">
      <div className="rounded-xl border bg-background/60 px-3 py-2">
        <textarea
          className="max-h-28 min-h-9 w-full resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            streaming ? "继续对话（当前回合中发送会立即插入）…" : "追问、追加指令…"
          }
          ref={inputRef}
          rows={1}
          value={text}
        />
        <div className="mt-1 flex items-center gap-1.5">
          {streaming ? (
            <Button
              className="h-6 gap-1 px-2 text-[11px] text-destructive"
              onClick={() => void window.pi.board.abort(agent.id)}
              size="sm"
              variant="ghost"
            >
              <SquareIcon className="size-2.5" />
              中断
            </Button>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">Enter 发送</span>
          <Button
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={sending || !text.trim()}
            onClick={send}
            size="sm"
          >
            {sending ? <Loader2Icon className="size-2.5 animate-spin" /> : null}
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}
