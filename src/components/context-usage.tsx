import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import type { SessionStats } from "@/hooks/useSessionStats";

/** 223000 -> "22.3万"; keeps the panel compact like ZCode's capacity card. */
function fmt(n: number | undefined) {
  if (n === undefined) return "—";
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w >= 100 ? w.toFixed(0) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return String(n);
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono" title={hint}>
        {value}
      </span>
    </div>
  );
}

/** Ring in the composer footer: context usage at a glance, click for details. */
export function ContextUsage({
  stats,
  onRefresh,
}: {
  stats: SessionStats | null;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) onRefresh();
  }, [open, onRefresh]);

  const ctx = stats?.contextUsage;
  const percent = Math.min(ctx?.percent ?? 0, 100);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  // Providers only report cache usage when they support prompt caching (and
  // pass it through). Zero read AND write means "not reported", not "0% hit".
  const hasCacheData = Boolean(stats && (stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0));
  const cacheHit =
    hasCacheData && stats && stats.tokens.input + stats.tokens.cacheRead > 0
      ? (stats.tokens.cacheRead / (stats.tokens.input + stats.tokens.cacheRead)) * 100
      : null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <PromptInputButton
          className="text-muted-foreground"
          title={
            ctx
              ? `上下文 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}（${ctx.percent.toFixed(1)}%）`
              : "上下文用量与花费"
          }
        >
          <svg className="-rotate-90" height="16" viewBox="0 0 20 20" width="16">
            <circle
              className="stroke-muted"
              cx="10"
              cy="10"
              fill="none"
              r={radius}
              strokeWidth="3"
            />
            <circle
              className={cn(
                "transition-[stroke-dashoffset]",
                percent >= 90
                  ? "stroke-destructive"
                  : percent >= 70
                    ? "stroke-amber-500"
                    : "stroke-primary",
              )}
              cx="10"
              cy="10"
              fill="none"
              r={radius}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - percent / 100)}
              strokeLinecap="round"
              strokeWidth="3"
            />
          </svg>
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-4" side="top">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-xs">上下文容量</span>
            <span className="text-muted-foreground text-xs">
              {ctx ? `${fmt(ctx.tokens)}/${fmt(ctx.contextWindow)}（${ctx.percent.toFixed(1)}%）` : "暂无数据"}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-amber-500" : "bg-primary",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>

          {stats ? (
            <>
              <div className="space-y-1.5 border-t pt-3">
                <Row label="提问 / 回复" value={`${stats.userMessages} / ${stats.assistantMessages}`} />
                <Row label="工具调用" value={String(stats.toolCalls)} />
                <Row label="消息总数" value={String(stats.totalMessages)} />
              </div>
              <div className="space-y-1.5 border-t pt-3">
                <Row label="输入 tokens" value={fmt(stats.tokens.input)} />
                <Row label="输出 tokens" value={fmt(stats.tokens.output)} />
                <Row label="缓存读 / 写" value={`${fmt(stats.tokens.cacheRead)} / ${fmt(stats.tokens.cacheWrite)}`} />
                <Row label="总计" value={fmt(stats.tokens.total)} />
              </div>
              <div className="space-y-1.5 border-t pt-3">
                <Row
                  hint={
                    hasCacheData
                      ? "cacheRead / (输入 + cacheRead)"
                      : "当前服务商未上报缓存用量（cacheRead / cacheWrite 均为 0）"
                  }
                  label="缓存命中率"
                  value={cacheHit === null ? "—" : `${cacheHit.toFixed(1)}%`}
                />
                <Row label="费用" value={`$${stats.cost.toFixed(4)}`} />
              </div>
              {!hasCacheData ? (
                <p className="text-[10px] text-muted-foreground/70">
                  该服务商未返回缓存用量，缓存命中率无法计算
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
