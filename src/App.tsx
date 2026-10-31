import { useEffect, useState } from "react";
import {
  BotIcon,
  GlobeIcon,
  BrainIcon,
  ChevronDownIcon,
  FilesIcon,
  FolderIcon,
  MessageSquarePlusIcon,
  Minimize2Icon,
  Settings2Icon,
  TerminalIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Chat } from "@/components/chat";
import { Composer } from "@/components/composer";
import { SettingsDialog, type SettingsTab } from "@/components/settings-dialog";
import { TerminalPanel } from "@/components/terminal-panel";
import { FilesPanel } from "@/components/files-panel";
import { AgentsPanel } from "@/components/agents-panel";
import { BrowserPanel } from "@/components/browser-panel";
import { CommandPalette, type PanelTab } from "@/components/command-palette";
import { usePi } from "@/hooks/usePi";
import { useTasks } from "@/hooks/useTasks";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/pi";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// pi has no plan mode, so the toggle sends a directive with the prompt and
// keeps the UI in a read-only-ish posture. Tools are still available to the model.
const PLAN_PREFIX =
  "只做分析与方案：不要修改文件、不要执行写操作命令，给出分步骤方案后停下等我确认。\n\n";

function timeAgo(ms: number) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export default function App() {
  return (
    <PromptInputProvider>
      <Shell />
    </PromptInputProvider>
  );
}

function Shell() {
  const {
    state,
    boot,
    prompt,
    send,
    setModel,
    setThinking,
    newSession,
    openSession,
    refreshSessions,
    renameSession,
    compact,
  } = usePi();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [planMode, setPlanMode] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [view, setView] = useState<"grouped" | "workspace" | "timeline">("grouped");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const { tasks, run: runTask, kill: killTask, remove: removeTask, hosts } = useTasks();

  (window as unknown as Record<string, unknown>).__pi = state;

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const submit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;
    const body = planMode ? PLAN_PREFIX + text : text;
    if (state.isStreaming) {
      send({ type: "follow_up", message: body });
    } else {
      prompt(body, message.files);
    }
  };

  const localCommand = (name: string) => {
    if (name === "new") newSession();
    else if (name === "compact") compact();
    else if (name === "plan") setPlanMode((v) => !v);
  };

  const projects = collectProjects(state.sessions);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="drag h-12 shrink-0" />
        <div className="flex items-center gap-1 pr-3 pb-2 pl-20">
          <Button
            className="gap-1.5 px-2"
            onClick={newSession}
            size="sm"
            title="新建任务"
            variant="secondary"
          >
            <MessageSquarePlusIcon className="size-3.5" />
            <span className="text-xs">新建任务</span>
          </Button>
          <Button
            className="ml-auto"
            onClick={() => setPaletteOpen(true)}
            size="icon-sm"
            title="搜索（⌘K）"
            variant="ghost"
          >
            <SearchIcon />
          </Button>
          <Button
            onClick={() => openSettings("skills")}
            size="icon-sm"
            title="技能"
            variant="ghost"
          >
            <WrenchIcon />
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="mx-2 mb-2 justify-start gap-2 text-xs" variant="ghost">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{state.cwd || "~"}</span>
              <ChevronDownIcon className="ml-auto size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-72">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              最近项目
            </DropdownMenuLabel>
            {projects.map((cwd) => (
              <DropdownMenuItem
                className="text-xs"
                key={cwd}
                onSelect={() => boot(cwd)}
              >
                <FolderIcon className="size-3.5" />
                <span className="truncate">{cwd}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs"
              onSelect={async () => {
                const dir = await window.pi.pickFolder();
                if (dir) boot(dir);
              }}
            >
              <FolderIcon className="size-3.5" />
              打开文件夹…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-0.5 px-2 pb-1">
          {(["grouped", "workspace", "timeline"] as const).map((v) => (
            <button
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-sidebar-accent",
                view === v && "bg-sidebar-accent text-foreground",
              )}
              key={v}
              onClick={() => setView(v)}
              type="button"
            >
              {v === "grouped" ? "分组" : v === "workspace" ? "工作区" : "时间线"}
            </button>
          ))}
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-sidebar-accent"
            onClick={() => setSort(sort === "updated" ? "created" : "updated")}
            type="button"
          >
            {sort === "updated" ? "按更新时间" : "按创建时间"}
          </button>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-px px-2 pb-2">
            {state.sessions.length === 0 ? (
              <p className="px-2 py-6 text-center text-muted-foreground text-xs">暂无任务</p>
            ) : null}
            {groupSessions(state.sessions, view, sort).map(([label, items]) => (
              <div key={label}>
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                  {label}
                </p>
                {items.map((s) => (
                  <TaskRow
                    active={state.sessionFile === s.path}
                    key={s.path}
                    onOpen={() => openSession(s.path)}
                    onRename={(title) => {
                      if (s.path === state.sessionFile) renameSession(title);
                      else {
                        send({ type: "switch_session", sessionPath: s.path }).then(() => {
                          renameSession(title);
                          openSession(s.path);
                        });
                      }
                    }}
                    onReveal={() => shellReveal(s.path)}
                    renaming={renaming === s.path}
                    session={s}
                    setRenaming={setRenaming}
                    streaming={state.sessionFile === s.path && state.isStreaming}
                  />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t p-2">
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-sidebar-accent"
            onClick={() => openSettings("general")}
            type="button"
          >
            <Settings2Icon className="size-4 text-muted-foreground" />
            设置
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">⌘K</span>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="max-w-56 truncate text-xs text-muted-foreground">
            {state.sessionName ?? "未命名会话"}
          </span>
          {planMode ? (
            <Badge className="text-[10px]" variant="secondary">
              计划模式
            </Badge>
          ) : null}

          <div className="no-drag ml-auto flex items-center gap-1.5">
            <Button
              className={cn("h-7 px-2 text-xs", panel === "terminal" && "bg-accent")}
              onClick={() => setPanel(panel === "terminal" ? null : "terminal")}
              title="终端 / 后台任务"
              variant="ghost"
            >
              <TerminalIcon className="size-3.5" />
              {tasks.some((t) => t.status === "running") ? (
                <span className="ml-0.5 size-1.5 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              className={cn("h-7 px-2 text-xs", panel === "files" && "bg-accent")}
              onClick={() => setPanel(panel === "files" ? null : "files")}
              title="文件"
              variant="ghost"
            >
              <FilesIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("h-7 px-2 text-xs", panel === "agents" && "bg-accent")}
              onClick={() => setPanel(panel === "agents" ? null : "agents")}
              title="子智能体"
              variant="ghost"
            >
              <BotIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("h-7 px-2 text-xs", panel === "browser" && "bg-accent")}
              onClick={() => setPanel(panel === "browser" ? null : "browser")}
              title="内置浏览器"
              variant="ghost"
            >
              <GlobeIcon className="size-3.5" />
            </Button>
            <Button
              className="h-7 px-2 text-xs"
              onClick={compact}
              title="压缩上下文"
              variant="ghost"
            >
              <Minimize2Icon className="size-3.5" />
            </Button>

            <ModelSelector onOpenChange={setPickerOpen} open={pickerOpen}>
              <ModelSelectorTrigger asChild>
                <Button className="h-7 gap-1 px-2 text-xs" size="sm" variant="outline">
                  <ZapIcon className="size-3" />
                  <span className="max-w-40 truncate">{state.model?.name ?? "选择模型"}</span>
                  <ChevronDownIcon className="size-3 opacity-50" />
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="选择模型">
                <ModelSelectorInput placeholder="搜索模型…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>没有匹配的模型</ModelSelectorEmpty>
                  {groupByProvider(state.models).map(([provider, models]) => (
                    <ModelSelectorGroup heading={provider} key={provider}>
                      {models.map((m) => (
                        <ModelSelectorItem
                          key={`${m.provider}/${m.id}`}
                          onSelect={() => {
                            setModel(m);
                            setPickerOpen(false);
                          }}
                          value={`${m.provider} ${m.name} ${m.id}`}
                        >
                          <ModelSelectorName>{m.name}</ModelSelectorName>
                          {m.reasoning ? (
                            <Badge className="ml-auto text-[10px]" variant="outline">
                              reasoning
                            </Badge>
                          ) : null}
                        </ModelSelectorItem>
                      ))}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
          </div>
        </header>

        {state.status === "exited" || state.status === "error" ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
            {state.error ?? "连接失败"}
          </div>
        ) : null}

        <Chat state={state} />

        <div className="mx-auto w-full max-w-3xl px-6 pb-4">
          <QueueBar queue={state.queue} onClear={() => send({ type: "clear_queue" })} />
          <Composer
            commands={state.commands}
            cwd={state.cwd}
            onLocalCommand={localCommand}
            onStop={() => send({ type: "abort" })}
            onSubmit={submit}
            onTogglePlan={() => setPlanMode((v) => !v)}
            planMode={planMode}
            streaming={state.isStreaming}
          >
            <PromptInputSelect onValueChange={setThinking} value={state.thinkingLevel}>
              <PromptInputSelectTrigger className="h-7 gap-1 text-xs">
                <BrainIcon className="size-3.5" />
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {THINKING.map((t) => (
                  <PromptInputSelectItem key={t} value={t}>
                    {t}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
          </Composer>
        </div>
      </main>

      <SettingsDialog
        cwd={state.cwd}
        onChanged={() => boot(state.cwd)}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
        open={settingsOpen}
      />

      {panel ? (
        <aside className="flex w-96 shrink-0 flex-col border-l bg-sidebar">
          <div className="flex h-12 shrink-0 items-center gap-0.5 border-b px-2">
            {([
              ["files", "文件", FilesIcon],
              ["terminal", "终端", TerminalIcon],
              ["agents", "子智能体", BotIcon],
              ["browser", "浏览器", GlobeIcon],
            ] as const).map(([tab, label, Icon]) => (
              <button
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent",
                  panel === tab && "bg-accent text-foreground",
                )}
                key={tab}
                onClick={() => setPanel(tab)}
                type="button"
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
            <Button
              className="ml-auto h-6 px-1.5"
              onClick={() => setPanel(null)}
              size="sm"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {panel === "terminal" ? (
              <TerminalPanel
                cwd={state.cwd}
                onKill={killTask}
                onRemove={removeTask}
                hosts={hosts}
                onRun={(cmd, host) => runTask(cmd, state.cwd, host)}
                tasks={tasks}
              />
            ) : null}
            {panel === "files" ? <FilesPanel cwd={state.cwd} /> : null}
            {panel === "agents" ? <AgentsPanel cwd={state.cwd} state={state} /> : null}
            {panel === "browser" ? <BrowserPanel cwd={state.cwd} /> : null}
          </div>
        </aside>
      ) : null}

      <CommandPalette
        actions={{
          newSession,
          compact,
          settings: () => openSettings("general"),
          pickFolder: async () => {
            const dir = await window.pi.pickFolder();
            if (dir) boot(dir);
          },
          panel: (tab) => setPanel(tab),
        }}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
      />
    </div>
  );
}

function QueueBar({
  queue,
  onClear,
}: {
  queue: { steering: string[]; followUp: string[] };
  onClear: () => void;
}) {
  const items = [
    ...queue.steering.map((text) => ({ text, kind: "打断" })),
    ...queue.followUp.map((text) => ({ text, kind: "排队" })),
  ];
  if (!items.length) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5">
      {items.map((item, i) => (
        <span className="flex items-center gap-1 rounded bg-background px-1.5 py-0.5 text-[11px]">
          <span className="text-muted-foreground">{item.kind}</span>
          <span className="max-w-40 truncate">{item.text}</span>
        </span>
      ))}
      <Button className="ml-auto h-6 px-1.5 text-[11px]" onClick={onClear} variant="ghost">
        <Trash2Icon className="mr-1 size-3" /> 清空队列
      </Button>
    </div>
  );
}

const shellReveal = (target: string) => window.pi.reveal(target);

type SessionRow = {
  path: string;
  title: string;
  cwd: string;
  mtime: number;
  changed?: { added: number; removed: number };
};

/** One task row: title, relative time, status dot, hover menu. */
function TaskRow({
  session,
  active,
  streaming,
  renaming,
  setRenaming,
  onOpen,
  onRename,
  onReveal,
}: {
  session: SessionRow;
  active: boolean;
  streaming: boolean;
  renaming: boolean;
  setRenaming: (path: string | null) => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  onReveal: () => void;
}) {
  if (renaming) {
    return (
      <Input
        autoFocus
        className="h-7 text-xs"
        defaultValue={session.title}
        onBlur={() => setRenaming(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const value = (e.target as HTMLInputElement).value.trim();
            setRenaming(null);
            if (value) onRename(value);
          }
          if (e.key === "Escape") setRenaming(null);
        }}
      />
    );
  }
  return (
    <div className="group relative">
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-7 text-left hover:bg-sidebar-accent",
          active && "bg-sidebar-accent",
        )}
        onClick={onOpen}
        type="button"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            streaming ? "animate-pulse bg-amber-500" : "bg-muted-foreground/40",
          )}
          title={streaming ? "运行中" : "已完成"}
        />
        <span className="min-w-0 flex-1 truncate text-xs">{session.title}</span>
        {session.changed && session.changed.added + session.changed.removed > 0 ? (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-emerald-500">+{session.changed.added}</span>{" "}
            <span className="text-rose-500">−{session.changed.removed}</span>
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {timeAgo(session.mtime).replace("前", "")}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100"
            size="icon-sm"
            variant="ghost"
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(session.path)}>重命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpen}>打开</DropdownMenuItem>
          <DropdownMenuItem onSelect={onReveal}>在 Finder 中显示</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** ZCode's three list views: day buckets, by workspace, or one flat timeline. */
function groupSessions(
  sessions: SessionRow[],
  view: "grouped" | "workspace" | "timeline",
  sort: "updated" | "created",
): [string, SessionRow[]][] {
  const list = sessions
    .slice()
    .sort((a, b) => (sort === "updated" ? b.mtime - a.mtime : a.mtime - b.mtime));
  if (view === "timeline") return [["时间线", list]];

  const buckets = new Map<string, SessionRow[]>();
  for (const session of list) {
    const label =
      view === "workspace"
        ? session.cwd.split("/").pop() || session.cwd
        : dayBucket(session.mtime);
    const bucket = buckets.get(label) ?? [];
    bucket.push(session);
    buckets.set(label, bucket);
  }
  return [...buckets.entries()];
}

function dayBucket(ms: number) {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(new Date().toDateString()).getTime();
  if (ms >= start) return "今天";
  if (ms >= start - day) return "昨天";
  if (ms >= start - 7 * day) return "本周";
  return "更早";
}

function collectProjects(sessions: { cwd: string }[]) {
  const seen = new Set<string>();
  for (const s of sessions) seen.add(s.cwd);
  return [...seen].slice(0, 8);
}

function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
