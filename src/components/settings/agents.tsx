import { useState, useEffect } from "react";
import {
  BotIcon,
  FolderIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { CfgSnapshot, AgentProfile } from "@/lib/pi";
import { Card } from "./shared";
import type { ApplyFn } from "./shared";

// extracted from settings-dialog.tsx
const ALIASES: Record<string, string> = {
  scout: "Explore · 代码库侦察",
  reviewer: "代码审查",
  delegate: "通用任务",
  worker: "实现",
  researcher: "调研",
  oracle: "决策顾问",
  "evidence-auditor": "证据审查",
};


export function AgentsPanel({ cfg, cwd, onChanged }: { cfg: CfgSnapshot; cwd: string; onChanged: () => void }) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    window.pi.agents(cwd).then(setProfiles).catch(() => setProfiles([]));
  }, [cwd]);

  const overrides =
    (cfg.settings.subagents as { agentOverrides?: Record<string, { model?: string; thinking?: string }> })
      ?.agentOverrides ?? {};

  // pi-subagents resolves: agentOverrides.<name>.model → frontmatter → subagents.defaultModel → parent model.
  const setOverride = async (name: string, field: "model" | "thinking", value: string) => {
    await window.pi.cfg.setSetting({ [`subagents.agentOverrides.${name}.${field}`]: value || null });
    setSaved(name);
    onChanged();
  };

  // External CLI adapters (claude-code / codex / cursor) need their own binaries
  // and auth, so they sit below the built-in semantic roles.
  const isExternal = (name: string) => /^(claude-code|codex-exec|cursor-agent)/.test(name);
  const ordered = [
    ...profiles.filter((p) => !isExternal(p.name)),
    ...profiles.filter((p) => isExternal(p.name)),
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        子智能体来自 pi-subagents 的内置 profile 与 &lt;项目&gt;/.pi/agents。留空即继承默认模型。
      </p>
      {ordered.map((profile) => {
        const current = overrides[profile.name] ?? {};
        return (
          <Card
            desc={profile.description}
            icon={BotIcon}
            key={profile.path}
            title={
              <>
                {ALIASES[profile.name] ?? profile.name}
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                  {profile.name}
                </span>
                <Badge className="ml-2 text-[11px]" variant="outline">
                  {profile.scope === "builtin" ? "内置" : "项目"}
                </Badge>
                {saved === profile.name ? (
                  <span className="ml-2 text-[11px] text-emerald-500">已保存</span>
                ) : null}
              </>
            }
          >
            <Select
              onValueChange={(value) => setOverride(profile.name, "model", value === "inherit" ? "" : value)}
              value={current.model ?? "inherit"}
            >
              <SelectTrigger className="h-9 w-48 text-xs">
                <SelectValue placeholder="继承默认" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem className="text-xs" value="inherit">
                  继承默认
                </SelectItem>
                {cfg.providers.flatMap((provider) =>
                  provider.models.map((model) => (
                    <SelectItem
                      className="text-xs"
                      key={`${provider.name}/${model.id}`}
                      value={`${provider.name}/${model.id}`}
                    >
                      {provider.displayName} · {model.name}
                    </SelectItem>
                  )),
                )}
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => setOverride(profile.name, "thinking", value === "inherit" ? "" : value)}
              value={current.thinking ?? "inherit"}
            >
              <SelectTrigger className="h-9 w-28 text-xs">
                <SelectValue placeholder="思考" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem className="text-xs" value="inherit">
                  继承默认
                </SelectItem>
                {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
                  <SelectItem className="text-xs" key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Card>
        );
      })}
    </div>
  );
}



export function ProjectsPanel({ cwd }: { cwd: string }) {
  const [sessions, setSessions] = useState<{ cwd: string }[]>([]);

  useEffect(() => {
    window.pi.sessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);

  return (
    <div className="space-y-2">
      {[...counts.entries()].map(([dir, count]) => (
        <div className="flex items-center gap-2 rounded-xl border bg-card/40 px-4 py-3" key={dir}>
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{dir}</span>
          {dir === cwd ? (
            <Badge className="text-[11px]" variant="secondary">
              当前
            </Badge>
          ) : null}
          <span className="text-[11px] text-muted-foreground">{count} 个任务</span>
        </div>
      ))}
    </div>
  );
}
