import { useEffect, useMemo, useState } from "react";
import { BotIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { blocksOf, textOf, type AgentProfile } from "@/lib/pi";
import type { State } from "@/hooks/usePi";

type Run = {
  id: string;
  agent: string;
  task: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  output?: string;
};

/** Flatten every subagent tool call in the transcript into a run list. */
function runsOf(state: State): Run[] {
  const runs: Run[] = [];
  const push = (id: string, args: Record<string, unknown> | undefined) => {
    const exec = state.tools[id];
    runs.push({
      id,
      agent: String(args?.agent ?? exec?.name ?? "subagent"),
      task: String(args?.task ?? args?.prompt ?? "").slice(0, 200),
      status:
        exec?.status === "error" ? "error" : exec?.status === "done" ? "done" : "running",
      durationMs: exec?.durationMs,
    });
  };

  for (const message of state.messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocksOf(message)) {
      if (block.type === "toolCall" && block.name.includes("subagent")) {
        push(block.id, block.arguments);
      }
    }
  }
  for (const block of state.streaming ?? []) {
    if (block.type === "toolCall" && block.name.includes("subagent")) {
      push(block.id, block.arguments);
    }
  }

  // toolResult carries the child's final text.
  for (const message of state.messages) {
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const run = runs.find((r) => r.id === message.toolCallId);
    if (run) run.output = textOf(message.content);
  }
  return runs;
}

export function AgentsPanel({ state, cwd }: { state: State; cwd: string }) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const runs = useMemo(() => runsOf(state), [state]);

  useEffect(() => {
    window.pi.agents(cwd).then(setProfiles).catch(() => setProfiles([]));
  }, [cwd]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <section className="border-b">
        <h3 className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
          本次会话的子智能体（{runs.length}）
        </h3>
        {runs.length === 0 ? (
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
            让 agent 分派任务给子智能体后，这里显示每个子任务的状态和产物。
          </p>
        ) : null}
        {runs.map((run) => (
          <div className="border-t" key={run.id}>
            <button
              className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-accent/60"
              onClick={() => setOpen(open === run.id ? null : run.id)}
              type="button"
            >
              {run.status === "running" ? (
                <Loader2Icon className="mt-0.5 size-3 shrink-0 animate-spin text-amber-500" />
              ) : (
                <BotIcon
                  className={cn(
                    "mt-0.5 size-3 shrink-0",
                    run.status === "error" ? "text-rose-500" : "text-emerald-500",
                  )}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate text-[11px] font-medium">{run.agent}</span>
                  {run.durationMs ? (
                    <span className="text-[10px] text-muted-foreground">
                      {(run.durationMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                </span>
                <span className="line-clamp-2 block text-[10px] text-muted-foreground">{run.task}</span>
              </span>
              <ChevronDownIcon
                className={cn("mt-0.5 size-3 shrink-0", open === run.id && "rotate-180")}
              />
            </button>
            {open === run.id ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/30 p-2 font-mono text-[10px] leading-4">
                {run.output ?? "（还没有产物）"}
              </pre>
            ) : null}
          </div>
        ))}
      </section>

      <section>
        <h3 className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
          可用的子智能体（{profiles.length}）
        </h3>
        {profiles.map((profile) => (
          <div className="border-t px-2 py-1.5" key={profile.path}>
            <div className="flex items-center gap-1.5">
              <BotIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate text-[11px] font-medium">{profile.name}</span>
              <Badge className="text-[9px]" variant="outline">
                {profile.scope === "builtin" ? "内置" : "项目"}
              </Badge>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
              {profile.description || profile.tools}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
