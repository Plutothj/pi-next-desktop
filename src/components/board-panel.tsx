// 并行 agent 任务板：派生独立 pi 会话在后台干活，主聊天不受影响。
// v1 卡片：状态 + 输出尾巴 + 停止 / 完成后转正（在主界面打开该会话）。
import { useEffect, useState } from "react";
import { Loader2Icon, RocketIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
    await window.pi.board
      .run({ name: name.trim() || undefined, cwd, message: message.trim() })
      .catch(() => null);
    setBusy(false);
    setMessage("");
    window.pi.board.list().then(setAgents).catch(() => {});
  };

  const running = agents.filter((a) => a.status === "running").length;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="space-y-2 rounded-xl border bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RocketIcon className="size-3.5" />
          新建并行任务
          <span className="ml-auto">{running ? `${running} 个运行中` : ""}</span>
        </div>
        <Input
          className="h-8 text-xs"
          onChange={(e) => setName(e.target.value)}
          placeholder="任务名（可选），如：审查 PR"
          value={name}
        />
        <Textarea
          className="min-h-16 text-xs"
          onChange={(e) => setMessage(e.target.value)}
          placeholder="要做的事。它会在独立会话里自己干，完成后通知你。"
          value={message}
        />
        <Button
          className="h-7 w-full gap-1.5 text-xs"
          disabled={busy || !message.trim()}
          onClick={launch}
          size="sm"
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <RocketIcon className="size-3" />}
          发射（{cwd.split(/[\\/]/).pop() || cwd}）
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto">
        {agents.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">
            还没有并行任务。派一个出去，你继续聊你的。
          </p>
        ) : null}
        {[...agents].reverse().map((a) => (
          <div className="rounded-xl border bg-card/40 p-3" key={a.id}>
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
              <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-muted-foreground">
                {a.tail}
              </pre>
            ) : null}
            <div className="mt-1.5 flex gap-1">
              {a.status === "running" ? (
                <Button
                  className="h-6 px-2 text-[11px] text-destructive"
                  onClick={() => void window.pi.board.stop(a.id)}
                  size="sm"
                  variant="ghost"
                >
                  <SquareIcon className="mr-1 size-2.5" />
                  停止
                </Button>
              ) : null}
              {a.status === "done" && a.sessionFile ? (
                <Button
                  className="h-6 px-2 text-[11px]"
                  onClick={() => a.sessionFile && onPromote(a.sessionFile, a.cwd)}
                  size="sm"
                  variant="outline"
                >
                  打开会话
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
