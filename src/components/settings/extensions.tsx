import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import type { CfgSnapshot } from "@/lib/pi";
import { Section } from "./shared";

// extracted from settings-dialog.tsx
export function ExtensionsPanel({
  cfg,
  onApply,
}: {
  cfg: CfgSnapshot;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const entries = Array.isArray(cfg.settings.extensions) ? (cfg.settings.extensions as string[]) : [];
  const builtin = ["builtin:mcp", "builtin:llama.cpp", "builtin:codemode", "builtin:tool-search"];

  const toggle = (name: string, enabled: boolean) => {
    const rest = entries.filter((entry) => entry !== `-${name}` && entry !== `+${name}`);
    const next = enabled ? [...rest, `+${name}`] : [...rest, `-${name}`];
    window.pi.cfg.setSetting({ extensions: next }).then((r) => onApply(r ?? { ok: true }));
  };

  return (
    <div className="space-y-8">
      <Section hint="pi 内置扩展，全部默认加载。" title="内置扩展">
        {builtin.map((name) => (
          <div className="flex items-center gap-4 rounded-xl border bg-card/40 px-5 py-3.5" key={name}>
            <div className="min-w-0 flex-1">
              <p className="text-sm">{name.replace("builtin:", "")}</p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">{name}</p>
            </div>
            <Switch checked={!entries.includes(`-${name}`)} onCheckedChange={(v) => toggle(name, v)} />
          </div>
        ))}
      </Section>

      <Section hint="settings.json 的 extensions 里手写的路径或 +name 条目。" title="其它扩展">
        {entries.filter((entry) => !builtin.some((name) => entry.endsWith(name))).length === 0 ? (
          <p className="text-xs text-muted-foreground">没有自定义扩展。</p>
        ) : (
          entries
            .filter((entry) => !builtin.some((name) => entry.endsWith(name)))
            .map((entry) => (
              <div
                className="flex items-center gap-4 rounded-xl border bg-card/40 px-5 py-3.5"
                key={entry}
              >
                <p className="min-w-0 flex-1 truncate font-mono text-xs">{entry}</p>
                <Badge variant="secondary">{entry.startsWith("-") ? "禁用" : "启用"}</Badge>
              </div>
            ))
        )}
      </Section>
    </div>
  );
}

