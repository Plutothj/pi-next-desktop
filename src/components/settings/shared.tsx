// Shared building blocks for the settings tabs (Card / ModelRow / Section).

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ZapIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CfgSnapshot } from "@/lib/pi";

export type ApplyFn = (r: { ok: boolean; error?: string }) => Promise<void>;

// Shared building blocks for the settings tabs (Section/Card).


export function Card({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 rounded-xl border bg-card/40 px-5 py-4">
      <div className="mt-0.5 rounded-lg bg-muted p-2">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {desc ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{desc}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function ModelRow({
  cfg,
  local,
  onChange,
}: {
  cfg: CfgSnapshot;
  local: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const provider = String(local.defaultProvider ?? "");
  const model = String(local.defaultModel ?? "");
  const models = cfg.providers.find((p) => p.name === provider)?.models ?? [];

  return (
    <Card desc="新会话默认使用的供应商和模型。" icon={ZapIcon} title="默认模型">
      <Select
        onValueChange={(value) => {
          onChange("defaultProvider", value);
          const first = cfg.providers.find((p) => p.name === value)?.models[0];
          if (first) onChange("defaultModel", first.id);
        }}
        value={provider}
      >
        <SelectTrigger className="h-9 w-40 text-xs">
          <SelectValue placeholder="供应商" />
        </SelectTrigger>
        <SelectContent>
          {cfg.providers.map((p) => (
            <SelectItem className="text-xs" key={p.name} value={p.name}>
              {p.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select onValueChange={(value) => onChange("defaultModel", value)} value={model}>
        <SelectTrigger className="h-9 w-44 text-xs">
          <SelectValue placeholder="模型" />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem className="text-xs" key={m.id} value={m.id}>
              {m.name ?? m.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Card>
  );
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------- appearance

