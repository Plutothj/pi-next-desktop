import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { UsageEntry, UsageReport } from "@/lib/pi";

type Days = "all" | 7 | 30;

const RANGES: { label: string; value: Days }[] = [
  { label: "最近 7 天", value: 7 },
  { label: "最近 30 天", value: 30 },
  { label: "全部", value: "all" },
];

/** 223000 -> "22.3万"; keeps numbers compact. */
const fmt = (n: number) => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w >= 100 ? w.toFixed(0) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return String(Math.round(n * 100) / 100);
};

const fmtCost = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

const CHART_DAYS = 30;

function ModelBars({ models }: { models: UsageReport["byModel"] }) {
  const max = Math.max(...models.map((m) => m.total), 1);
  return (
    <div className="space-y-2">
      {models.map((m) => {
        const share = Math.round((m.total / max) * 100);
        const shareOfAll = models[0] ? Math.round((m.total / Math.max(models.reduce((s, x) => s + x.total, 0), 1)) * 100) : 0;
        return (
          <div key={`${m.provider}/${m.model}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-mono" title={`${m.provider}/${m.model}`}>
                {m.model}
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {fmt(m.total)} tok · {fmtCost(m.cost)} · {m.messages} 次
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(share, 2)}%` }}
                title={`${shareOfAll}% · 输入 ${fmt(m.input)} / 输出 ${fmt(m.output)} / 缓存读 ${fmt(m.cacheRead)} / 缓存写 ${fmt(m.cacheWrite)}`}
              />
            </div>
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span>输入 {fmt(m.input)}</span>
              <span>输出 {fmt(m.output)}</span>
              <span>缓存读 {fmt(m.cacheRead)}</span>
              <span>缓存写 {fmt(m.cacheWrite)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayChart({ byDay }: { byDay: UsageReport["byDay"] }) {
  const days = byDay.slice(-CHART_DAYS);
  const max = Math.max(...days.map((d) => d.total), 1);
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">该时间段没有用量记录。</p>;
  }
  return (
    <div>
      <div className="flex h-32 items-end gap-px">
        {days.map((d) => (
          <div
            className="group relative flex h-full min-w-[3px] flex-1 flex-col justify-end"
            key={d.day}
            title={`${d.day} · ${fmt(d.total)} tok · ${fmtCost(d.cost)} · ${d.messages} 条`}
          >
            <div
              className={cn(
                "w-full rounded-t-sm transition-colors group-hover:bg-primary",
                d.total > 0 ? "bg-primary/60" : "bg-muted",
              )}
              style={{ height: `${Math.max((d.total / max) * 100, d.total > 0 ? 3 : 1)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{days[0]?.day}</span>
        {days.length > CHART_DAYS ? <span>仅显示最近 {CHART_DAYS} 天</span> : null}
        <span>{days.at(-1)?.day}</span>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card/40 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg">{value}</p>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/** 全局用量统计：跨所有会话聚合，按模型拆分 + 按天图表 + 时间筛选。 */
export function UsagePanel() {
  const [days, setDays] = useState<Days>("all");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: Days) => {
    setError(null);
    try {
      setReport(await window.pi.stats.usage(range));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const totals: UsageEntry | undefined = report?.totals;
  const grandTotal = report?.byModel.reduce((s, m) => s + m.total, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">统计自本机所有 pi 会话文件</p>
        <div className="flex overflow-hidden rounded-md border">
          {RANGES.map((r) => (
            <button
              className={cn(
                "px-2.5 py-1 text-[11px] hover:bg-accent",
                days === r.value ? "bg-accent font-medium" : "text-muted-foreground",
              )}
              key={String(r.value)}
              onClick={() => setDays(r.value)}
              type="button"
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="总 tokens" value={fmt(totals?.total ?? 0)} />
        <SummaryCard label="总费用" value={fmtCost(totals?.cost ?? 0)} />
        <SummaryCard label="会话数" value={String(report?.sessions ?? 0)} />
        <SummaryCard label="回复轮次" value={String(report?.assistantMessages ?? 0)} />
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          每日用量
        </h3>
        <DayChart byDay={report?.byDay ?? []} />
      </section>

      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          按模型
        </h3>
        {report && report.byModel.length > 0 ? (
          <ModelBars models={report.byModel} />
        ) : (
          <p className="text-xs text-muted-foreground">该时间段没有用量记录。</p>
        )}
      </section>

      {totals ? (
        <section className="space-y-1.5 border-t pt-3">
          <TotalRow label="输入 tokens" value={fmt(totals.input)} />
          <TotalRow label="输出 tokens" value={fmt(totals.output)} />
          <TotalRow label="缓存读 / 写" value={`${fmt(totals.cacheRead)} / ${fmt(totals.cacheWrite)}`} />
          <TotalRow label="总计" value={fmt(grandTotal || totals.total)} />
          <TotalRow label="费用" value={fmtCost(totals.cost)} />
        </section>
      ) : null}
    </div>
  );
}
