// 计划工作台：浏览 .pi/plans/*.md（计划模式与双模型链的落盘产物），
// 查看 markdown、按计划执行（把文档路径交给 agent）、删除。
import { useCallback, useEffect, useState } from "react";
import { ClipboardListIcon, Loader2Icon, PlayIcon, Trash2Icon } from "lucide-react";
import { mermaid } from "@streamdown/mermaid";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

type PlanItem = { path: string; name: string; mtime: number; size: number };

export function PlanWorkbench({
  cwd,
  onExecute,
}: {
  cwd: string;
  onExecute: (file: string) => void;
}) {
  const [plans, setPlans] = useState<PlanItem[] | null>(null);
  const [selected, setSelected] = useState<PlanItem | null>(null);
  const [content, setContent] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await window.pi.plans.list(cwd).catch(() => []);
    setPlans(list);
    if (selected && !list.some((p) => p.path === selected.path)) setSelected(null);
  }, [cwd, selected]);

  useEffect(() => {
    setPlans(null);
    setSelected(null);
    window.pi.plans.list(cwd).then(setPlans).catch(() => setPlans([]));
  }, [cwd]);

  const open = async (plan: PlanItem) => {
    setSelected(plan);
    setContent(null);
    const res = await window.pi.plans.read(cwd, plan.path).catch(() => null);
    setContent(res?.ok ? (res.content ?? "") : (res?.error ?? "读取失败"));
  };

  const remove = async (plan: PlanItem) => {
    if (!confirm(`删除计划 ${plan.name}？`)) return;
    await window.pi.plans.delete(cwd, plan.path).catch(() => null);
    if (selected?.path === plan.path) setSelected(null);
    window.pi.plans.list(cwd).then(setPlans).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <ClipboardListIcon className="size-3.5" />
        计划
        <span className="flex-1">{plans ? `${plans.length} 份` : ""}</span>
        <Button className="h-6 w-6 p-0" onClick={refresh} size="sm" variant="ghost">
          <Loader2Icon className={cn("size-3", plans === null && "animate-spin")} />
        </Button>
      </div>

      {plans !== null && plans.length === 0 ? (
        <p className="pt-6 text-center text-xs text-muted-foreground">
          还没有计划。用计划模式跑一个任务，方案会自动落盘到这里。
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
        {(plans ?? []).map((plan) => (
          <div
            className={cn(
              "rounded-xl border bg-card/40 p-2.5",
              selected?.path === plan.path && "border-primary/40",
            )}
            key={plan.path}
          >
            <button
              className="w-full truncate text-left text-xs font-medium hover:text-primary"
              onClick={() => void open(plan)}
              type="button"
            >
              {plan.name}
            </button>
            <div className="mt-1 flex items-center gap-1">
              <span className="flex-1 text-[10px] text-muted-foreground">
                {new Date(plan.mtime).toLocaleString()} · {Math.max(1, Math.round(plan.size / 1024))}k
              </span>
              <Button
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => onExecute(plan.path)}
                size="sm"
                variant="outline"
              >
                <PlayIcon className="size-2.5" />
                执行
              </Button>
              <Button
                className="h-6 w-6 p-0 text-destructive"
                onClick={() => void remove(plan)}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon className="size-2.5" />
              </Button>
            </div>
            {selected?.path === plan.path && content !== null ? (
              <div className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted/30 p-2 text-xs">
                <MessageResponse plugins={{ mermaid }} shikiTheme={["github-light", "github-dark-dimmed"]}>
                  {content}
                </MessageResponse>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
