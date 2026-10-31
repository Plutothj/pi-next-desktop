import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PlayIcon, SquareIcon, Trash2Icon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TaskInfo } from "@/lib/pi";

const statusDot = {
  running: "bg-amber-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-rose-500",
} as const;

export function TerminalPanel({
  tasks,
  cwd,
  hosts,
  onRun,
  onKill,
  onRemove,
}: {
  tasks: TaskInfo[];
  cwd: string;
  hosts: string[];
  onRun: (cmd: string, host?: string) => void;
  onKill: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [cmd, setCmd] = useState("");
  const [host, setHost] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const current = tasks.find((t) => t.id === selected) ?? tasks[0];

  useEffect(() => {
    if (!selected && tasks[0]) setSelected(tasks[0].id);
  }, [tasks, selected]);

  const submit = () => {
    if (!cmd.trim()) return;
    onRun(cmd.trim(), host || undefined);
    setCmd("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          className="h-7 flex-1 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={`在 ${cwd.split("/").pop() || "~"} 运行命令，后台执行…`}
          value={cmd}
        />
        {hosts.length > 0 ? (
          <select
            className="h-6 rounded border bg-transparent px-1 text-[11px] text-muted-foreground"
            onChange={(e) => setHost(hosts[Number(e.target.value)] ?? "")}
            title="远程执行"
            value={host ? String(hosts.indexOf(host)) : ""}
          >
            <option value="">本机</option>
            {hosts.map((h, i) => (
              <option key={h} value={i}>
                {h}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          className="h-7 px-2"
          disabled={!cmd.trim()}
          onClick={submit}
          size="sm"
          variant="ghost"
        >
          <PlayIcon className="size-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-40 shrink-0 overflow-auto border-r">
          {tasks.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">暂无后台任务</p>
          ) : null}
          {tasks.map((task) => (
            <button
              className={cn(
                "flex w-full items-center gap-1.5 border-b px-2 py-1.5 text-left hover:bg-accent/60",
                current?.id === task.id && "bg-accent",
              )}
              key={task.id}
              onClick={() => setSelected(task.id)}
              type="button"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", statusDot[task.status])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px]">{task.label}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {duration(task)}
                  {task.exitCode !== null ? ` · exit ${task.exitCode}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {current.cmd}
                </span>
                {current.status === "running" ? (
                  <Button
                    className="ml-auto h-6 px-1.5"
                    onClick={() => onKill(current.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <SquareIcon className="size-3" />
                  </Button>
                ) : (
                  <Loader2Icon className="ml-auto size-0" />
                )}
                <Button
                  className="h-6 px-1.5 text-destructive"
                  onClick={() => onRemove(current.id)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
              <OutputPane task={current} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
              命令在后台运行，不阻塞对话。可以随时切回来看输出。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputPane({ task }: { task: TaskInfo }) {
  const ref = useRef<HTMLPreElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [task.output, stick]);

  return (
    <pre
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      }}
      ref={ref}
    >
      {task.output || (task.status === "running" ? "运行中…" : "无输出")}
    </pre>
  );
}

function duration(task: TaskInfo) {
  const ms = (task.endedAt ?? Date.now()) - task.startedAt;
  if (ms < 1000) return "刚刚";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
