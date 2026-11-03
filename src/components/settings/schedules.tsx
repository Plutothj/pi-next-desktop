// 定时任务面板：每天 HH:MM 触发，把预置 prompt 派给并行 agent 执行，完成通知。
import { useEffect, useState } from "react";
import { ClockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Section } from "./shared";

type Schedule = {
  id: string;
  name: string;
  time: string; // HH:MM
  cwd: string;
  message: string;
  enabled: boolean;
  lastRun: string | null;
};

export function SchedulesPanel({ cwd }: { cwd: string }) {
  const [items, setItems] = useState<Schedule[]>([]);
  const [time, setTime] = useState("09:00");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => window.pi.schedules.list().then(setItems).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const add = async () => {
    const res = await window.pi.schedules
      .save({ time: time.trim(), name: name.trim(), message: message.trim(), cwd })
      .catch((err: Error) => ({ ok: false, error: err.message }));
    if (!res.ok) {
      setError(res.error ?? "保存失败");
      return;
    }
    setError(null);
    setMessage("");
    refresh();
  };

  const toggle = async (s: Schedule) => {
    await window.pi.schedules.save({ ...s, enabled: !s.enabled }).catch(() => null);
    refresh();
  };

  const remove = async (s: Schedule) => {
    if (!confirm(`删除定时任务「${s.name}」？`)) return;
    await window.pi.schedules.delete(s.id).catch(() => null);
    refresh();
  };

  return (
    <div className="space-y-8">
      <Section
        hint="每天定点把任务派给并行 agent 后台执行，完成后系统通知。应用需保持运行（托盘驻留即可）。"
        title="定时任务"
      >
        <div className="space-y-2 rounded-xl border bg-card/40 p-3">
          <div className="flex gap-2">
            <Input
              className="h-8 w-24 text-xs"
              onChange={(e) => setTime(e.target.value)}
              placeholder="08:30"
              value={time}
            />
            <Input
              className="h-8 flex-1 text-xs"
              onChange={(e) => setName(e.target.value)}
              placeholder="任务名（可选），如：晨间代码审查"
              value={name}
            />
          </div>
          <Textarea
            className="min-h-16 text-xs"
            onChange={(e) => setMessage(e.target.value)}
            placeholder="要做的事（在当前工作区执行），如：review 昨天的提交，输出摘要报告"
            value={message}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button
            className="h-7 gap-1 text-xs"
            disabled={!message.trim()}
            onClick={add}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="size-3" /> 添加
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有定时任务。</p>
        ) : null}
        {items.map((s) => (
          <div className="flex items-center gap-3 rounded-xl border bg-card/40 px-4 py-3" key={s.id}>
            <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm">{s.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{s.time}</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">{s.message}</p>
            </div>
            <Button
              className={cn("h-7 text-xs", s.enabled && "text-primary")}
              onClick={() => void toggle(s)}
              size="sm"
              variant="ghost"
            >
              {s.enabled ? "已启用" : "已禁用"}
            </Button>
            <Button
              className="h-7 w-7 p-0 text-destructive"
              onClick={() => void remove(s)}
              size="sm"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </Section>
    </div>
  );
}
