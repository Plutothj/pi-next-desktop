import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  HammerIcon,
  ZapIcon,
  BarChart3Icon as BarChartIcon,
  BotIcon,
  BoxesIcon,
  BrainIcon,
  CheckIcon,
  DownloadIcon,
  KeyRoundIcon,
  Loader2Icon,
  PackageIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  Trash2Icon,
  WrenchIcon,
  FolderIcon,
  PaletteIcon,
  PlugIcon,
  SettingsIcon,
  SquareTerminalIcon as TerminalSquareIcon,
  UserIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AgentProfile, CfgSnapshot, GalleryPackage, ProviderInfo } from "@/lib/pi";

export type SettingsTab =
  | "general"
  | "appearance"
  | "providers"
  | "persona"
  | "memory"
  | "agents"
  | "packages"
  | "mcp"
  | "skills"
  | "commands"
  | "stats"
  | "tools"
  | "shell"
  | "extensions"
  | "projects";

// Nav mirrors ZCode's Settings: top-level items, then Agent 能力, then 数据与统计.
const NAV: { group?: string; items: { id: SettingsTab; label: string; icon: typeof BoxesIcon }[] }[] = [
  {
    items: [
      { id: "general", label: "常规", icon: SettingsIcon },
      { id: "appearance", label: "外观", icon: PaletteIcon },
      { id: "providers", label: "模型设置", icon: KeyRoundIcon },
    ],
  },
  {
    group: "Agent 能力",
    items: [
      { id: "persona", label: "个性化", icon: UserIcon },
      { id: "memory", label: "记忆", icon: BrainIcon },
      { id: "agents", label: "子智能体", icon: BotIcon },
      { id: "packages", label: "插件", icon: PuzzleIcon },
      { id: "mcp", label: "MCP 服务器", icon: PlugIcon },
      { id: "skills", label: "技能", icon: WrenchIcon },
      { id: "commands", label: "命令", icon: TerminalSquareIcon },
      { id: "extensions", label: "扩展", icon: BoxesIcon },
    ],
  },
  {
    group: "工具与执行",
    items: [
      { id: "tools", label: "工具", icon: HammerIcon },
      { id: "shell", label: "终端与外壳", icon: TerminalSquareIcon },
    ],
  },
  {
    group: "数据与统计",
    items: [
      { id: "stats", label: "使用统计", icon: BarChartIcon },
      { id: "projects", label: "项目", icon: FolderIcon },
    ],
  },
];

type SField = {
  key: string;
  label: string;
  hint?: string;
  type: "bool" | "text" | "number" | "enum" | "list";
  options?: string[];
  placeholder?: string;
};

type SSection = { id: string; title: string; hint?: string; fields: SField[] };

// Mirrors docs/settings.md — every key that changes behavior on desktop is exposed here.
const SECTIONS: SSection[] = [
  {
    id: "model",
    title: "模型",
    hint: "默认模型在「模型设置」里选；这里控制思考与可用范围。",
    fields: [
      {
        key: "defaultThinkingLevel",
        label: "默认思考等级",
        hint: "新会话的思考预算档位。",
        type: "enum",
        options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
      {
        key: "enabledModels",
        label: "启用模型",
        hint: "逗号分隔的匹配模式，如 anthropic/*、*/sonnet-4*。留空表示全部可用。",
        type: "list",
        placeholder: "留空 = 全部",
      },
    ],
  },
  {
    id: "session",
    title: "会话",
    fields: [
      {
        key: "sessionDir",
        label: "会话目录",
        hint: "留空使用 ~/.pi/agent/sessions。相对路径从工作目录算起。",
        type: "text",
        placeholder: "~/.pi/agent/sessions",
      },
      {
        key: "sessionShareDestination",
        label: "分享目标",
        hint: "/share 使用的目的地。",
        type: "enum",
        options: ["auto", "gist", "radius"],
      },
      {
        key: "defaultProjectTrust",
        label: "默认项目信任",
        hint: "只对用户级 settings.json 生效。",
        type: "enum",
        options: ["ask", "always", "never"],
      },
      { key: "enableSkillCommands", label: "技能注册为 /skill:name 命令", type: "bool" },
    ],
  },
  {
    id: "context",
    title: "上下文与压缩",
    fields: [
      { key: "compaction.enabled", label: "自动压缩上下文", type: "bool" },
      {
        key: "compaction.reserveTokens",
        label: "压缩预留 tokens",
        hint: "剩余上下文低于该值时触发压缩。默认 16384。",
        type: "number",
      },
      {
        key: "compaction.keepRecentTokens",
        label: "保留最近 tokens",
        hint: "最近这段内容不做摘要。默认 20000。",
        type: "number",
      },
      { key: "branchSummary.skipPrompt", label: "分支摘要跳过确认", type: "bool" },
      { key: "branchSummary.reserveTokens", label: "分支摘要预留 tokens", type: "number" },
    ],
  },
  {
    id: "retry",
    title: "重试",
    fields: [
      { key: "retry.enabled", label: "自动重试", type: "bool" },
      { key: "retry.maxRetries", label: "最大重试次数", type: "number" },
      { key: "retry.baseDelayMs", label: "首次退避延迟 (ms)", type: "number" },
      { key: "retry.maxAgentDelayMs", label: "最大退避延迟 (ms)", type: "number" },
    ],
  },
  {
    id: "interaction",
    title: "交互",
    fields: [
      {
        key: "steeringMode",
        label: "插话投递方式",
        hint: "排队中的 steering 消息怎么送进正在跑的回合。",
        type: "enum",
        options: ["one-at-a-time", "all"],
      },
      {
        key: "followUpMode",
        label: "跟进投递方式",
        type: "enum",
        options: ["one-at-a-time", "all"],
      },
      { key: "externalEditor", label: "外部编辑器命令", type: "text", placeholder: "$EDITOR" },
      {
        key: "doubleEscapeAction",
        label: "连按 Esc",
        type: "enum",
        options: ["tree", "fork", "none"],
      },
      {
        key: "treeFilterMode",
        label: "会话树默认过滤",
        type: "enum",
        options: ["default", "no-tools", "user-only", "labeled-only", "all"],
      },
    ],
  },
  {
    id: "network",
    title: "网络",
    fields: [
      {
        key: "transport",
        label: "传输方式",
        hint: "供应商支持多种传输时的偏好。",
        type: "enum",
        options: ["auto", "sse", "websocket", "websocket-cached"],
      },
      {
        key: "httpProxy",
        label: "HTTP 代理",
        hint: "只对用户级 settings.json 生效。",
        type: "text",
        placeholder: "http://127.0.0.1:7890",
      },
      { key: "httpIdleTimeoutMs", label: "HTTP 空闲超时 (ms)", type: "number" },
      {
        key: "cacheWarming",
        label: "提示缓存预热",
        hint: "off / streaming（运行中）/ idle（会话之间）。",
        type: "enum",
        options: ["streaming", "idle", "off"],
      },
    ],
  },
  {
    id: "advanced",
    title: "高级",
    fields: [
      { key: "retry.provider.maxRetries", label: "供应商级重试次数", type: "number" },
      {
        key: "retry.provider.maxRetryDelayMs",
        label: "供应商最长重试延迟 (ms)",
        type: "number",
      },
      { key: "collapseChangelog", label: "更新后精简 changelog", type: "bool" },
      { key: "enableInstallTelemetry", label: "安装遥测", type: "bool" },
      { key: "enableAnalytics", label: "使用分析", type: "bool" },
      { key: "warnings.anthropicExtraUsage", label: "Anthropic 额外用量警告", type: "bool" },
    ],
  },
  {
    id: "appearance",
    title: "外观",
    hint: "桌面端自己渲染消息，这些开关影响传给模型与界面的内容。",
    fields: [
      { key: "hideThinkingBlock", label: "隐藏思考块", type: "bool" },
      { key: "showCacheMissNotices", label: "显示缓存未命中提示", type: "bool" },
      { key: "images.autoResize", label: "图片自动缩放到 2000px 内", type: "bool" },
      { key: "images.blockImages", label: "禁止向模型发送图片", type: "bool" },
    ],
  },
  {
    id: "tools",
    title: "工具",
    fields: [
      {
        key: "defaultTools",
        label: "启用的工具",
        hint: "逗号分隔。纯名字替换默认集合，+name 增加、-name 移除。",
        type: "list",
        placeholder: "read, bash, edit, write",
      },
      {
        key: "codemode.mode",
        label: "codemode 模式",
        hint: "on：声明过的工具照常可见；only：模型只能通过脚本调工具。",
        type: "enum",
        options: ["on", "only"],
      },
      { key: "codemode.inlineBudget", label: "codemode 声明预算 (tokens)", type: "number" },
    ],
  },
  {
    id: "shell",
    title: "终端与外壳",
    fields: [
      {
        key: "shellPath",
        label: "Shell 路径",
        hint: "bash 工具用的 shell，支持 ~。",
        type: "text",
        placeholder: "默认 shell",
      },
      { key: "shellCommandPrefix", label: "命令前缀", hint: "每条 shell 命令前自动加。", type: "text" },
      {
        key: "npmCommand",
        label: "npm 命令",
        hint: "包的查找与安装命令，逗号分隔。",
        type: "list",
        placeholder: "npm",
      },
    ],
  },
];

const GROUPS: Record<string, string[]> = {
  general: ["model", "session", "context", "retry", "interaction", "network", "advanced"],
  appearance: ["appearance"],
  tools: ["tools"],
  shell: ["shell"],
};

const getPath = (obj: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[part];
    return undefined;
  }, obj);

function SettingsForm({
  cfg,
  sections,
}: {
  cfg: CfgSnapshot;
  sections: string[];
}) {
  const [local, setLocal] = useState<Record<string, unknown>>(cfg.settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => setLocal(cfg.settings), [cfg.settings]);

  const patch = (key: string, value: unknown) => {
    const next = { ...local };
    const parts = key.split(".");
    let node = next;
    for (const part of parts.slice(0, -1)) {
      node[part] = { ...((node[part] as Record<string, unknown>) ?? {}) };
      node = node[part] as Record<string, unknown>;
    }
    if (value === "" || value === null) delete node[parts.at(-1) as string];
    else node[parts.at(-1) as string] = value;
    setLocal(next);
    window.pi.cfg.setSetting({ [key]: value === "" ? null : value }).then((r) => {
      setSaved(r?.ok ?? true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <div className="space-y-8 pb-10">
      {saved ? (
        <div className="fixed top-4 right-10 z-10 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-400">
          已保存
        </div>
      ) : null}
      {sections.map((id) => {
        const section = SECTIONS.find((s) => s.id === id);
        if (!section) return null;
        return (
          <Section hint={section.hint} key={id} title={section.title}>
            {id === "model" ? (
              <ModelRow cfg={cfg} local={local} onChange={(key, value) => patch(key, value)} />
            ) : null}
            {section.fields.map((field) => (
              <FieldRow
                field={field}
                key={field.key}
                onChange={(value) => patch(field.key, value)}
                value={getPath(local, field.key)}
              />
            ))}
          </Section>
        );
      })}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: SField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string>(
    Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value),
  );

  useEffect(() => {
    setDraft(Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value));
  }, [value]);

  const commit = (text: string) => {
    if (field.type === "number") {
      const num = Number(text);
      onChange(text === "" ? "" : Number.isFinite(num) ? num : undefined);
      return;
    }
    if (field.type === "list") {
      onChange(
        text
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      return;
    }
    onChange(text);
  };

  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card/40 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{field.label}</p>
        {field.hint ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{field.hint}</p>
        ) : null}
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">{field.key}</p>
      </div>
      <div className="shrink-0">
        {field.type === "bool" ? (
          <Switch checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        ) : null}
        {field.type === "enum" ? (
          <Select onValueChange={onChange} value={value === undefined ? "" : String(value)}>
            <SelectTrigger className="h-9 w-48 text-xs">
              <SelectValue placeholder="默认" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem className="text-xs" key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {field.type === "text" || field.type === "number" || field.type === "list" ? (
          <Input
            className={cn("h-9 text-xs", field.type === "number" ? "w-32 text-right" : "w-64")}
            onBlur={() => commit(draft)}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={field.placeholder}
            type={field.type === "number" ? "number" : "text"}
            value={draft}
          />
        ) : null}
      </div>
    </div>
  );
}

function ExtensionsPanel({
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

export function SettingsDialog({
  open,
  onOpenChange,
  cwd,
  onChanged,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string;
  onChanged: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");
  const [cfg, setCfg] = useState<CfgSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  const load = useCallback(async () => {
    const snapshot = await window.pi.cfg.read(cwd);
    setCfg(snapshot);
  }, [cwd]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  const apply = async (result: { ok: boolean; error?: string }) => {
    if (!result.ok) {
      setLog(result.error ?? "操作失败");
      return;
    }
    await load();
    onChanged();
  };

  const activeLabel =
    NAV.flatMap((section) => section.items).find((item) => item.id === tab)?.label ?? "设置";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex bg-background text-foreground">
      {/* 顶部留出 macOS 交通灯的高度，并做成可拖动区域 */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-9"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <nav className="flex w-60 shrink-0 flex-col border-r bg-sidebar px-3 pb-3 pt-12">
        <Button
          className="mb-2 h-9 justify-start gap-2 text-[13px]"
          onClick={() => onOpenChange(false)}
          variant="ghost"
        >
          <ArrowLeftIcon className="size-4" />
          返回工作区
        </Button>
        <div className="mx-1 mb-2 h-px bg-border" />
        <div className="min-h-0 flex-1 overflow-auto">
          {NAV.map((section, i) => (
            <div className="mb-2" key={section.group ?? i}>
              {section.group ? (
                <p className="px-2.5 pt-3 pb-1.5 text-[11px] font-medium text-muted-foreground">
                  {section.group}
                </p>
              ) : null}
              {section.items.map(({ id, label, icon: Icon }) => (
                <button
                  className={cn(
                    "mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-accent/70",
                    tab === id && "bg-accent font-medium",
                  )}
                  key={id}
                  onClick={() => setTab(id)}
                  type="button"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-10">
          <h2 className="text-sm font-semibold">{activeLabel}</h2>
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
            {cfg?.agentDir ?? ""}
          </span>
        </header>

        {!cfg ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" /> 读取配置…
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-5xl px-10 py-8">
              {tab === "providers" ? (
                <ProvidersPanel
                  busy={busy}
                  cfg={cfg}
                  onApply={apply}
                  setBusy={setBusy}
                  setLog={setLog}
                />
              ) : null}
              {tab === "packages" ? (
                <PackagesPanel
                  busy={busy}
                  cfg={cfg}
                  onApply={apply}
                  setBusy={setBusy}
                  setLog={setLog}
                />
              ) : null}
              {tab === "skills" ? <SkillsPanel cfg={cfg} cwd={cwd} onApply={apply} /> : null}
              {tab === "general" ? <SettingsForm cfg={cfg} sections={GROUPS.general} /> : null}
              {tab === "appearance" ? <SettingsForm cfg={cfg} sections={GROUPS.appearance} /> : null}
              {tab === "tools" ? <SettingsForm cfg={cfg} sections={GROUPS.tools} /> : null}
              {tab === "shell" ? <SettingsForm cfg={cfg} sections={GROUPS.shell} /> : null}
              {tab === "extensions" ? <ExtensionsPanel cfg={cfg} onApply={apply} /> : null}
              {tab === "persona" ? (
                <PersonaPanel cfg={cfg} onApply={apply} setLog={setLog} />
              ) : null}
              {tab === "memory" ? <MemoryPanel cfg={cfg} /> : null}
              {tab === "agents" ? <AgentsPanel cfg={cfg} cwd={cwd} onChanged={onChanged} /> : null}
              {tab === "mcp" ? <McpPanel cfg={cfg} onApply={apply} /> : null}
              {tab === "commands" ? <CommandsPanel cfg={cfg} /> : null}
              {tab === "stats" ? <StatsPanel /> : null}
              {tab === "projects" ? <ProjectsPanel cwd={cwd} /> : null}
            </div>
          </div>
        )}

        {log ? (
          <div className="max-h-28 shrink-0 overflow-auto border-t bg-muted/40 px-10 py-2 font-mono text-xs text-muted-foreground">
            {log.split("\n").slice(-6).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- providers

function ProvidersPanel({
  cfg,
  setBusy,
  setLog,
  onApply,
}: {
  cfg: CfgSnapshot;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ProviderInfo | "new" | null>(null);

  const remove = async (name: string) => {
    if (!confirm(`删除供应商 ${name} 及其密钥？`)) return;
    await onApply(await window.pi.cfg.deleteProvider(name));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {cfg.providers.length} 个供应商 · 保存后 pi 会重启
        </p>
        <Button className="h-9 gap-1.5 text-xs" onClick={() => setEditing("new")} size="sm">
          <PlusIcon className="size-3.5" /> 添加供应商
        </Button>
      </div>

      <div className="space-y-2">
        {cfg.providers.map((p) => (
          <div
            className="flex items-center gap-3 rounded-xl border bg-card/40 px-4 py-3"
            key={p.name}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{p.displayName}</span>
                {p.custom ? (
                  <Badge className="text-[11px]" variant="secondary">
                    自定义
                  </Badge>
                ) : null}
                {p.hasKey ? (
                  <Badge className="text-[11px]" variant="outline">
                    <CheckIcon className="mr-1 size-2.5" />
                    {p.keyHint ?? "已配置"}
                  </Badge>
                ) : (
                  <Badge className="text-[11px] text-destructive" variant="outline">
                    缺少密钥
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {p.models.length} 个模型 · {p.api ?? "未知协议"} · {p.baseUrl ?? "内置"}
              </p>
            </div>
            <Button className="h-9 px-3 text-xs" onClick={() => setEditing(p)} size="sm" variant="ghost">
              编辑
            </Button>
            <Button
              className="h-9 px-2 text-destructive"
              onClick={() => remove(p.name)}
              size="sm"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {editing ? (
        <ProviderForm
          apiKinds={cfg.apiKinds}
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onApply({ ok: true });
          }}
          onStatus={(msg, isBusy) => {
            setLog(msg);
            setBusy(isBusy);
          }}
          setBusy={setBusy}
          setLog={setLog}
        />
      ) : null}
    </div>
  );
}

function ProviderForm({
  initial,
  apiKinds,
  onSaved,
  onCancel,
  setBusy,
  setLog,
  onStatus,
}: {
  initial: ProviderInfo | null;
  apiKinds: string[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
  onStatus: (msg: string, busy: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState(initial?.api ?? "openai-completions");
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState(
    (initial?.models ?? []).map((m) => m.id).join("\n"),
  );

  const save = async () => {
    setSaving(true);
    setBusy(true);
    setLog(null);
    const list = models
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, label, ...flags] = line.split(/[|,]/).map((s) => s.trim());
        return {
          id,
          name: label || id,
          reasoning: flags.includes("reasoning"),
          input: flags.includes("image") ? ["text", "image"] : ["text"],
        };
      });

    const res = await window.pi.cfg.saveProvider({
      name: name.trim(),
      displayName: displayName.trim() || name.trim(),
      api,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || undefined,
      models: list,
    });
    setSaving(false);
    setBusy(false);
    if (!res.ok) {
      setLog(res.error ?? "保存失败");
      return;
    }
    onStatus(`已保存 ${name}`, false);
    await onSaved();
  };

  return (
    <div className="space-y-4 rounded-md border bg-muted/20 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="供应商 ID">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setName(e.target.value)}
            placeholder="deepseek"
            value={name}
          />
        </Field>
        <Field label="显示名">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="DeepSeek"
            value={displayName}
          />
        </Field>
        <Field label="协议">
          <Select onValueChange={setApi} value={api}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {apiKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Base URL">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            value={baseUrl}
          />
        </Field>
      </div>

      <Field label="API Key">
        <Input
          className="h-9 text-xs"
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial?.hasKey ? "已配置，留空则不修改" : "sk-…"}
          type="password"
          value={apiKey}
        />
      </Field>

      <Field label="模型（每行一个：id | 名称 | reasoning,image）">
        <Textarea
          className="min-h-20 font-mono text-xs"
          onChange={(e) => setModels(e.target.value)}
          placeholder={"deepseek-chat\n deepseek-reasoner | DeepSeek R1 | reasoning"}
          value={models}
        />
      </Field>

      <div className="flex justify-end gap-2">
        <Button className="h-7 text-xs" onClick={onCancel} size="sm" variant="ghost">
          取消
        </Button>
        <Button className="h-7 text-xs" disabled={saving || !name.trim()} onClick={save} size="sm">
          {saving ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// -------------------------------------------------------------- packages

function PackagesPanel({
  cfg,
  setBusy,
  setLog,
  onApply,
}: {
  cfg: CfgSnapshot;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [gallery, setGallery] = useState<GalleryPackage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [view, setView] = useState<"installed" | "market">("installed");

  const search = async (text: string) => {
    setSearching(true);
    const res = await window.pi.cfg.gallery(text);
    setSearching(false);
    if (Array.isArray(res)) setGallery(res);
    else {
      setGallery([]);
      setLog(res.error);
    }
  };

  useEffect(() => {
    search("");
  }, []);

  const install = async (source: string) => {
    setInstalling(source);
    setBusy(true);
    setLog(`安装 ${source}…`);
    const res = await window.pi.cfg.install(source);
    setBusy(false);
    setInstalling(null);
    if (!res.ok) setLog(res.log ?? res.error ?? "安装失败");
    else setLog(`已安装 ${source}`);
    await onApply({ ok: true });
    search(query);
  };

  const uninstall = async (source: string) => {
    if (!confirm(`卸载 ${source}？`)) return;
    setBusy(true);
    setLog(`卸载 ${source}…`);
    const res = await window.pi.cfg.uninstall(source);
    setBusy(false);
    setLog(res.ok ? `已卸载 ${source}` : (res.log ?? "卸载失败"));
    await onApply({ ok: true });
  };

  const toggleResource = async (
    source: string,
    disabled: Record<string, boolean>,
    kind: string,
  ) => {
    await window.pi.cfg.setResources(source, { ...disabled, [kind]: !disabled[kind] });
    await onApply({ ok: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-lg bg-muted/40 p-1">
        {(["installed", "market"] as const).map((key) => (
          <button
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs",
              view === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
            )}
            key={key}
            onClick={() => setView(key)}
            type="button"
          >
            {key === "installed" ? `已安装 ${cfg.packages.length}` : "扩展市场"}
          </button>
        ))}
      </div>

      {view === "installed" ? (
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">已安装（{cfg.packages.length}）</h3>
          <Button
            className="h-6 px-2 text-[11px]"
            onClick={() => onApply({ ok: true })}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon className="mr-1 size-3" /> 刷新
          </Button>
        </div>
        <div className="space-y-2">
          {cfg.packages.map((p) => (
            <div className="rounded-xl border bg-card/40 px-4 py-3" key={p.source}>
              <div className="flex items-center gap-2">
                <PackageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{p.name}</span>
                {p.version ? (
                  <Badge className="text-[11px]" variant="outline">
                    v{p.version}
                  </Badge>
                ) : null}
                <Button
                  className="ml-auto h-6 px-2 text-destructive"
                  onClick={() => uninstall(p.source)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
              {p.description ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(["extensions", "skills", "prompts", "themes"] as const).map((kind) =>
                  p.resources[kind] > 0 ? (
                    <button
                      className={cn(
                        "rounded-xl border bg-card/40 px-1.5 py-0.5 text-[11px] transition-colors",
                        p.disabled[kind]
                          ? "text-muted-foreground line-through"
                          : "bg-accent/60 text-foreground",
                      )}
                      key={kind}
                      onClick={() => toggleResource(p.source, p.disabled, kind)}
                      type="button"
                    >
                      {labelOf(kind)} {p.resources[kind]}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      ) : null}

      {view === "market" ? (
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">扩展市场</h3>
          <div className="ml-auto flex items-center gap-1">
            <Input
              className="h-7 w-44 text-xs"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search(query)}
              placeholder="搜索 npm pi-package…"
              value={query}
            />
            <Button
              className="h-7 px-2"
              disabled={searching}
              onClick={() => search(query)}
              size="sm"
              variant="outline"
            >
              {searching ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <BoxesIcon className="size-3" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {gallery === null ? (
            <p className="text-muted-foreground text-xs">加载中…</p>
          ) : gallery.length === 0 ? (
            <p className="text-muted-foreground text-xs">没有结果</p>
          ) : null}
          {gallery?.map((g) => (
            <div className="flex items-start gap-3 rounded-xl border bg-card/40 px-4 py-3" key={g.name}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{g.name}</span>
                  <Badge className="text-[11px]" variant="outline">
                    v{g.version}
                  </Badge>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{g.description}</p>
              </div>
              <Button
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                disabled={g.installed || installing === g.source}
                onClick={() => install(g.source)}
                size="sm"
                variant={g.installed ? "ghost" : "outline"}
              >
                {installing === g.source ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3" />
                )}
                {g.installed ? "已安装" : "安装"}
              </Button>
            </div>
          ))}
        </div>
      </section>
      ) : null}
    </div>
  );
}

const labelOf = (kind: string) =>
  ({ extensions: "扩展", skills: "技能", prompts: "提示", themes: "主题" })[kind] ?? kind;

// ---------------------------------------------------------------- skills

function SkillsPanel({
  cfg,
  cwd,
  onApply,
}: {
  cfg: CfgSnapshot;
  cwd: string;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const [preview, setPreview] = useState<{ name: string; body: string } | null>(null);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof cfg.skills>();
    for (const s of cfg.skills) {
      const key = s.scope === "package" ? s.source : s.scope === "user" ? "用户" : "项目";
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [cfg.skills]);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">{cfg.skills.length} 个技能</p>
      {grouped.map(([group, skills]) => (
        <section className="space-y-2" key={group}>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {group}
          </h3>
          {skills.map((s) => (
            <div className="flex items-center gap-2 rounded-xl border bg-card/40 px-4 py-3" key={s.dir}>
              <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{s.name}</span>
                <p className="line-clamp-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
              <Button
                className="h-9 px-3 text-xs"
                onClick={async () =>
                  setPreview({ name: s.name, body: await window.pi.cfg.readSkill(s.path, cwd) })
                }
                size="sm"
                variant="ghost"
              >
                预览
              </Button>
              {s.scope === "user" ? (
                <Button
                  className="h-9 px-2 text-destructive"
                  onClick={async () => {
                    if (!confirm(`删除技能 ${s.name}？`)) return;
                    const res = await window.pi.cfg.deleteSkill(s.dir);
                    if (res.ok) await onApply({ ok: true });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ))}

      <Dialog onOpenChange={(v) => !v && setPreview(null)} open={Boolean(preview)}>
        <DialogContent className="max-h-[70vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.name}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh]">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5">{preview?.body}</pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------- general

function Card({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: typeof BoxesIcon;
  title: React.ReactNode;
  desc?: string;
  children?: React.ReactNode;
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

function ModelRow({
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

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
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

function AppearancePanel() {
  const [theme, setTheme] = useState(localStorage.getItem("pi-theme") ?? "dark");

  const apply = (next: string) => {
    setTheme(next);
    localStorage.setItem("pi-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  return (
    <Section hint="只影响界面外观，不影响对话内容。" title="主题">
      <div className="flex gap-2">
        {["dark", "light"].map((value) => (
          <Button
            className={cn("h-16 w-24 flex-col gap-1 text-xs", theme === value && "border-primary")}
            key={value}
            onClick={() => apply(value)}
            variant="outline"
          >
            <span
              className={cn(
                "h-6 w-14 rounded-xl border bg-card/40",
                value === "dark" ? "bg-zinc-900" : "bg-zinc-100",
              )}
            />
            {value === "dark" ? "深色" : "浅色"}
          </Button>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------- persona

function PersonaPanel({
  cfg,
  setLog,
}: {
  cfg: CfgSnapshot;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
  setLog: (v: string | null) => void;
}) {
  const [scope, setScope] = useState<"user" | "project">("user");
  const [field, setField] = useState<"system" | "append">("append");
  const initial = scope === "user" ? cfg.persona.userAppend : cfg.persona.projectAppend;
  const value =
    scope === "user"
      ? field === "system"
        ? cfg.persona.userSystem
        : cfg.persona.userAppend
      : field === "system"
        ? cfg.persona.projectSystem
        : cfg.persona.projectAppend;
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        SYSTEM.md 替换默认系统提示；APPEND_SYSTEM.md 追加在后面。用户级作用于所有项目。
      </p>
      <div className="flex gap-2">
        <Select onValueChange={(v) => setScope(v as "user" | "project")} value={scope}>
          <SelectTrigger className="h-9 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="text-xs" value="user">
              用户级
            </SelectItem>
            <SelectItem className="text-xs" value="project">
              项目级
            </SelectItem>
          </SelectContent>
        </Select>
        <Select onValueChange={(v) => setField(v as "system" | "append")} value={field}>
          <SelectTrigger className="h-9 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="text-xs" value="append">
              APPEND_SYSTEM.md
            </SelectItem>
            <SelectItem className="text-xs" value="system">
              SYSTEM.md
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          className="ml-auto h-8 text-xs"
          onClick={async () => {
            const res = await window.pi.cfg.savePersona({
              scope,
              field,
              content: draft ?? value,
            });
            setLog(res.ok ? "已保存，重启后会生效" : (res.error ?? "保存失败"));
            setDraft(null);
          }}
          size="sm"
        >
          保存
        </Button>
      </div>
      <Textarea
        className="min-h-[60vh] font-mono text-[13px] leading-6"
        onChange={(e) => setDraft(e.target.value)}
        placeholder="这里写内容…"
        value={draft ?? value ?? initial}
      />
    </div>
  );
}

// ------------------------------------------------------------- memory / mcp / commands

function MemoryPanel({ cfg }: { cfg: CfgSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{cfg.agentDir}/memory</p>
      {cfg.memory.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有记忆文件。</p>
      ) : null}
      {cfg.memory.map((file) => (
        <div className="rounded-xl border bg-card/40" key={file.path}>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/60"
            onClick={() => setOpen(open === file.path ? null : file.path)}
            type="button"
          >
            <span className="truncate text-xs">{file.name}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{file.size} 字</span>
          </button>
          {open === file.path ? (
            <pre className="max-h-64 overflow-auto border-t bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {file.preview}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function McpPanel({
  cfg,
  onApply,
}: {
  cfg: CfgSnapshot;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        配置在 {cfg.agentDir}/mcp.json，改动后重启会话生效。
      </p>
      {cfg.mcp.map((server) => (
        <div className="flex items-center gap-3 rounded-xl border bg-card/40 px-4 py-3" key={server.name}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{server.name}</span>
              <Badge className="text-[11px]" variant="outline">
                {server.transport}
              </Badge>
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{server.detail}</p>
          </div>
          <Button
            className="h-7 text-xs"
            onClick={() =>
              onApply(
                window.pi.cfg.setMcp(server.name, !server.enabled).then(
                  (r) => r ?? { ok: true },
                ) as never,
              )
            }
            size="sm"
            variant={server.enabled ? "secondary" : "outline"}
          >
            {server.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      ))}
    </div>
  );
}

function CommandsPanel({ cfg }: { cfg: CfgSnapshot }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        在 ~/.pi/agent/prompts 或 .pi/prompts 放 .md 文件，输入框里用 /名字 调用。
      </p>
      {cfg.prompts.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有自定义命令。</p>
      ) : null}
      {cfg.prompts.map((prompt) => (
        <div className="rounded-xl border bg-card/40 px-4 py-3" key={prompt.path}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">/{prompt.name}</span>
            <Badge className="text-[11px]" variant="outline">
              {prompt.scope === "user" ? "用户级" : "项目级"}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {prompt.description || prompt.preview}
          </p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- agents / stats / projects

/** Same roles ZCode shows (Explore / code review / general purpose), pi's names on the right. */
const ALIASES: Record<string, string> = {
  scout: "Explore · 代码库侦察",
  reviewer: "代码审查",
  delegate: "通用任务",
  worker: "实现",
  researcher: "调研",
  oracle: "决策顾问",
  "evidence-auditor": "证据审查",
};

function AgentsPanel({ cfg, cwd, onChanged }: { cfg: CfgSnapshot; cwd: string; onChanged: () => void }) {
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

function StatsPanel() {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    window.pi
      .send({ type: "get_session_stats" })
      .then((res) => setStats((res as Record<string, unknown>) ?? null))
      .catch(() => setStats({}));
  }, []);

  const rows = Object.entries(stats ?? {}).filter(
    ([, value]) => typeof value === "number" || typeof value === "string",
  );

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">当前会话还没有统计数据。</p>
      ) : null}
      {rows.map(([key, value]) => (
        <div className="flex items-center justify-between border-b py-1.5 text-xs" key={key}>
          <span className="text-muted-foreground">{key}</span>
          <span className="font-mono">{String(value)}</span>
        </div>
      ))}
    </div>
  );
}

function ProjectsPanel({ cwd }: { cwd: string }) {
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
