import { useCallback, useEffect, useState } from "react";
import {
  BotIcon,
  GlobeIcon,
  BrainIcon,
  CheckIcon,
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
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Chat } from "@/components/chat";
import { Composer } from "@/components/composer";
import { BranchPicker } from "@/components/branch-picker";
import { ContextUsage } from "@/components/context-usage";
import { ModelPicker } from "@/components/model-picker";
import { SettingsDialog, type SettingsTab } from "@/components/settings-dialog";
import { TerminalPanel } from "@/components/terminal-panel";
import { FilesPanel } from "@/components/files-panel";
import { AgentsPanel } from "@/components/agents-panel";
import { BrowserPanel } from "@/components/browser-panel";
import { CommandPalette, type PanelTab } from "@/components/command-palette";
import { usePi } from "@/hooks/usePi";
import { useTasks } from "@/hooks/useTasks";
import { useGit } from "@/hooks/useGit";
import { useSessionStats } from "@/hooks/useSessionStats";
import { baseName, cn } from "@/lib/utils";
import type { PiMessage } from "@/lib/pi";

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
    openProject,
    prompt,
    send,
    clearError,
    setModel,
    setThinking,
    newSession,
    openSession,
    deleteSession,
    refreshSessions,
    renameSession,
    compact,
    forkAt,
  } = usePi();
  const controller = usePromptInputController();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [planMode, setPlanMode] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [view, setView] = useState<"grouped" | "workspace" | "timeline">("workspace");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const { tasks, run: runTask, kill: killTask, remove: removeTask, hosts } = useTasks();
  const { git, refresh: refreshGit } = useGit(state.cwd, state.isStreaming);
  const { stats, refresh: refreshStats } = useSessionStats(
    state.sessionFile,
    state.isStreaming,
  );

  (window as unknown as Record<string, unknown>).__pi = state;

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const submit = (message: PromptInputMessage, behavior?: "steer" | "followUp") => {
    const text = message.text.trim();
    if (!text) return;
    const body = planMode ? PLAN_PREFIX + text : text;
    // Always name a streamingBehavior: it only matters while pi is mid-run
    // (where a missing one is rejected outright), and is ignored when idle.
    // This keeps sends working even if our isStreaming flag lags reality.
    prompt(body, message.files, behavior ?? "followUp");
  };

  const localCommand = (name: string) => {
    if (name === "new") newSession();
    else if (name === "compact") compact();
    else if (name === "plan") setPlanMode((v) => !v);
  };

  // Fork rebuilds history up to (not including) the chosen user prompt and
  // returns its text; prefill the composer so it can be edited and resent.
  const handleFork = useCallback(
    async (message: PiMessage) => {
      const res = await forkAt(message);
      if (res.ok && res.text) controller.textInput.setInput(res.text);
    },
    [forkAt, controller],
  );

  const activeProject =
    state.projects.find((p) => p.path === state.cwd) ??
    (state.cwd ? { path: state.cwd, name: baseName(state.cwd) } : null);

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
            <Button
              className="mx-2 mb-2 h-auto justify-start gap-2 py-1.5 text-xs"
              variant="ghost"
            >
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate">{activeProject?.name ?? "选择项目"}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {state.cwd || "~"}
                </span>
              </span>
              <ChevronDownIcon className="ml-auto size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              项目
            </DropdownMenuLabel>
            {state.projects.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                还没有项目，打开一个文件夹开始
              </p>
            ) : null}
            {state.projects.map((p) => (
              <DropdownMenuItem
                className="text-xs"
                key={p.path}
                onSelect={() => {
                  // Already the live workspace: just close the menu.
                  if (p.path !== state.cwd) openProject(p.path);
                }}
              >
                <FolderIcon className={cn("size-3.5 shrink-0", !p.exists && "opacity-40")} />
                <span className="min-w-0 flex-1 truncate" title={p.path}>
                  {p.name}
                  <span className="ml-1.5 text-[10px] text-muted-foreground">{p.sessions}</span>
                </span>
                {p.path === state.cwd ? <CheckIcon className="size-3 shrink-0" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs"
              onSelect={async () => {
                const dir = await window.pi.pickFolder();
                if (dir) openProject(dir);
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
            {groupSessions(state.sessions, state.projects, view, sort).map(([label, items]) => (
              <div key={label}>
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                  {label}
                </p>
                {items.length === 0 ? (
                  <p className="px-2 py-1 text-[10px] text-muted-foreground/60">暂无任务</p>
                ) : null}
                {items.map((s) => (
                  <TaskRow
                    active={state.sessionFile === s.path}
                    currentCwd={state.cwd}
                    key={s.path}
                    showProject={view !== "workspace"}
                    onDelete={() => deleteSession(s.path)}
                    onOpen={() => openSession(s.path, s.cwd)}
                    onRename={(title) => {
                      if (s.path === state.sessionFile) renameSession(title);
                      else {
                        // Renaming applies to the live session: switch first.
                        openSession(s.path, s.cwd).then(() => renameSession(title));
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
          </div>
        </header>

        {state.error || state.status === "exited" || state.status === "error" ? (
          <div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
            <span className="min-w-0 flex-1 break-words">{state.error ?? "连接失败"}</span>
            <button
              className="shrink-0 rounded px-1 opacity-60 hover:opacity-100"
              onClick={clearError}
              title="清除错误"
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : null}

        <Chat onFork={handleFork} state={state} />

        <div className="mx-auto w-full max-w-3xl px-6 pb-4">
          {git?.isRepo || Object.keys(state.statuses).length > 0 ? (
            <div className="mb-1.5 flex items-center gap-2 px-1">
              {git?.isRepo ? (
                <BranchPicker cwd={state.cwd} git={git} onSwitched={refreshGit} />
              ) : null}
              {Object.entries(state.statuses).map(([key, text]) => (
                <span
                  className="max-w-64 truncate rounded-md border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
                  key={key}
                  title={key}
                >
                  {text}
                </span>
              ))}
            </div>
          ) : null}
          <Composer
            commands={state.commands}
            cwd={state.cwd}
            onClearQueue={() => send({ type: "clear_queue" })}
            onLocalCommand={localCommand}
            onStop={() => send({ type: "abort" })}
            onSubmit={submit}
            onTogglePlan={() => setPlanMode((v) => !v)}
            planMode={planMode}
            queue={state.queue}
            streaming={state.isStreaming}
          >
            <ContextUsage onRefresh={refreshStats} stats={stats} />
            <ModelPicker
              model={state.model}
              models={state.models}
              onSelect={setModel}
            />
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
          openSession: (path, cwd) => openSession(path, cwd),
        }}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
        sessions={state.sessions}
      />
    </div>
  );
}

const shellReveal = (target: string) => window.pi.reveal(target);

type SessionRow = {
  path: string;
  id: string;
  title: string;
  cwd: string;
  mtime: number;
  changed?: { added: number; removed: number };
};

/** One task row: title, project badge, relative time, status dot, hover menu. */
function TaskRow({
  session,
  active,
  streaming,
  renaming,
  setRenaming,
  showProject,
  currentCwd,
  onOpen,
  onRename,
  onReveal,
  onDelete,
}: {
  session: SessionRow;
  active: boolean;
  streaming: boolean;
  renaming: boolean;
  setRenaming: (path: string | null) => void;
  showProject: boolean;
  currentCwd: string;
  onOpen: () => void;
  onRename: (title: string) => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Cross-project sessions carry a badge so the unified list stays readable.
  const project = baseName(session.cwd);
  const showBadge = showProject && session.cwd !== currentCwd;

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
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-9 text-left hover:bg-sidebar-accent",
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
        {showBadge ? (
          <span
            className="max-w-20 shrink-0 truncate rounded bg-muted px-1 py-px text-[9px] text-muted-foreground"
            title={session.cwd}
          >
            {project}
          </span>
        ) : null}
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
      <DropdownMenu onOpenChange={(open) => !open && setConfirmingDelete(false)}>
        <DropdownMenuTrigger asChild>
          <Button
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100"
            size="icon-xs"
            variant="ghost"
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(session.path)}>重命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpen}>打开</DropdownMenuItem>
          <DropdownMenuItem onSelect={onReveal}>在 Finder 中显示</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard.writeText(session.id);
            }}
          >
            复制会话 ID
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(confirmingDelete ? "text-destructive focus:text-destructive" : "text-muted-foreground")}
            onSelect={(e) => {
              // Two-step inline confirm instead of a modal.
              if (!confirmingDelete) {
                e.preventDefault();
                setConfirmingDelete(true);
                return;
              }
              onDelete();
            }}
          >
            {confirmingDelete ? "确认删除" : "删除"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** ZCode's three list views: day buckets, by workspace, or one flat timeline. */
function groupSessions(
  sessions: SessionRow[],
  projects: { path: string; name: string }[],
  view: "grouped" | "workspace" | "timeline",
  sort: "updated" | "created",
): [string, SessionRow[]][] {
  const list = sessions
    .slice()
    .sort((a, b) => (sort === "updated" ? b.mtime - a.mtime : a.mtime - b.mtime));
  if (view === "timeline") return [["时间线", list]];

  if (view === "workspace") {
    // Projects without sessions still get a group, so the sidebar reads as a
    // project list rather than an archive of past work.
    const labels = new Map<string, string>();
    const buckets = new Map<string, SessionRow[]>();
    for (const project of projects) {
      labels.set(project.path, project.name);
      buckets.set(project.path, []);
    }
    for (const session of list) {
      const bucket = buckets.get(session.cwd) ?? [];
      bucket.push(session);
      buckets.set(session.cwd, bucket);
    }
    return [...buckets.entries()].map(([cwd, items]) => [
      labels.get(cwd) ?? baseName(cwd),
      items,
    ]);
  }

  const buckets = new Map<string, SessionRow[]>();
  for (const session of list) {
    const label = dayBucket(session.mtime);
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

