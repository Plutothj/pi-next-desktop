import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  HammerIcon,
  BarChart3Icon as BarChartIcon,
  BotIcon,
  BoxesIcon,
  BrainIcon,
  KeyRoundIcon,
  Loader2Icon,
  PuzzleIcon,
  WrenchIcon,
  FolderIcon,
  InfoIcon,
  PaletteIcon,
  PlugIcon,
  SettingsIcon,
  SquareTerminalIcon as TerminalSquareIcon,
  UserIcon,
} from "lucide-react";
import { Section } from "@/components/settings/shared";
import { ModelRow } from "@/components/settings/shared";
import { AboutPanel } from "@/components/settings/about";
import { AppearancePanel } from "@/components/settings/appearance";
import { ProvidersPanel } from "@/components/settings/providers";
import { PackagesPanel } from "@/components/settings/packages";
import { SkillsPanel } from "@/components/settings/skills";
import { ExtensionsPanel } from "@/components/settings/extensions";
import { PersonaPanel } from "@/components/settings/persona";
import { MemoryPanel, McpPanel, CommandsPanel } from "@/components/settings/memory";
import { AgentsPanel, ProjectsPanel } from "@/components/settings/agents";
import { UsagePanel } from "@/components/settings/usage";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CfgSnapshot, } from "@/lib/pi";

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
  | "projects"
  | "about";

// Nav mirrors ZCode's Settings: top-level items, then Agent 能力, then 数据与统计.
// keywords：设置页搜索的匹配词（含俗称），让"缩放"能找到外观、"密钥"找到模型设置。
const NAV_KEYWORDS: Record<SettingsTab, string[]> = {
  general: ["默认模型", "会话", "压缩", "重试", "网络", "代理", "思考"],
  appearance: ["主题", "深色", "浅色", "缩放", "字体大小", "zoom"],
  providers: ["模型", "供应商", "密钥", "apikey", "api", "baseurl", "请求头", "预设"],
  persona: ["系统提示词", "人设", "system"],
  memory: ["记忆", "memory", "mcp"],
  agents: ["子智能体", "subagent", "项目"],
  packages: ["插件", "包", "市场", "扩展"],
  mcp: ["mcp", "服务器"],
  skills: ["技能", "skill"],
  commands: ["命令", "自定义命令", "prompt"],
  stats: ["统计", "用量", "token", "费用"],
  tools: ["工具", "codemode"],
  shell: ["shell", "终端", "命令行"],
  extensions: ["扩展", "extension"],
  projects: ["项目", "工作区", "目录"],
  about: ["版本", "更新", "升级", "about"],
};
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
      { id: "about", label: "版本", icon: InfoIcon },
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
        hint: "留空使用应用专属目录（~/.pi-desktop/agent/sessions）。相对路径从工作目录算起。",
        type: "text",
        placeholder: "~/.pi-desktop/agent/sessions",
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
  const [navQuery, setNavQuery] = useState("");

  // 设置页搜索：按标签 + 关键词过滤导航项
  const visibleNav = (() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (NAV_KEYWORDS[item.id] ?? []).some((k) => k.toLowerCase().includes(q)),
      ),
    })).filter((section) => section.items.length > 0);
  })();

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
        <Input
          className="mb-2 h-7 text-xs"
          onChange={(e) => setNavQuery(e.target.value)}
          placeholder="搜索设置项…"
          value={navQuery}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {visibleNav.map((section, i) => (
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
              {tab === "appearance" ? (
                <div className="space-y-8">
                  <AppearancePanel />
                  <SettingsForm cfg={cfg} sections={GROUPS.appearance} />
                </div>
              ) : null}
              {tab === "tools" ? <SettingsForm cfg={cfg} sections={GROUPS.tools} /> : null}
              {tab === "shell" ? <SettingsForm cfg={cfg} sections={GROUPS.shell} /> : null}
              {tab === "extensions" ? <ExtensionsPanel cfg={cfg} onApply={apply} /> : null}
              {tab === "persona" ? (
                <PersonaPanel cfg={cfg} onApply={apply} setLog={setLog} />
              ) : null}
              {tab === "memory" ? <MemoryPanel cfg={cfg} /> : null}
              {tab === "agents" ? <AgentsPanel cfg={cfg} cwd={cwd} onChanged={onChanged} /> : null}
              {tab === "mcp" ? <McpPanel cfg={cfg} onApply={apply} /> : null}
              {tab === "commands" ? (
                <CommandsPanel
                  cfg={cfg}
                  cwd={cwd}
                  onApply={apply}
                  setBusy={setBusy}
                  setLog={setLog}
                />
              ) : null}
              {tab === "stats" ? <UsagePanel /> : null}
              {tab === "projects" ? <ProjectsPanel cwd={cwd} /> : null}
              {tab === "about" ? <AboutPanel /> : null}
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

