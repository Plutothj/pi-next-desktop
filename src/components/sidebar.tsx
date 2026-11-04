import {
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquarePlusIcon,
  MoonIcon,
  SearchIcon,
  Settings2Icon,
  SunIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import logo from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { State } from "@/hooks/usePi";
import type { UpdateState } from "@/lib/pi";
import { baseName, cn } from "@/lib/utils";

function timeAgo(ms: number) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

type SessionRow = {
  path: string;
  id: string;
  title: string;
  cwd: string;
  mtime: number;
  changed?: { added: number; removed: number };
};

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

const shellReveal = (target: string) => window.pi.reveal(target);

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
  onExport,
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
  onExport: () => void;
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
          {active ? (
            <DropdownMenuItem onSelect={onExport}>导出 HTML…</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onReveal}>在 Finder 中显示</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard.writeText(session.id);
            }}
          >
            复制会话 ID
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(
              confirmingDelete ? "text-destructive focus:text-destructive" : "text-muted-foreground",
            )}
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

/** Left rail: project switcher, session list, settings/theme footer. */
const COLLAPSED_COUNT = 3;

export function SessionSidebar({
  state,
  theme,
  onOpenPalette,
  onOpenSkills,
  onOpenSettings,
  onCreateProject,
  onToggleTheme,
  openProject,
  openSession,
  deleteSession,
  renameSession,
  update,
  onUpdateAction,
  onRemoveProject,
}: {
  state: State;
  theme: "dark" | "light";
  onOpenPalette: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
  onCreateProject: () => void;
  onToggleTheme: () => void;
  openProject: (path: string) => void;
  openSession: (path: string, cwd?: string) => void | Promise<void>;
  deleteSession: (path: string) => Promise<void>;
  renameSession: (title: string) => Promise<void>;
  update: UpdateState;
  onUpdateAction: () => void;
  onRemoveProject: (dir: string) => Promise<void>;
}) {
  const [view, setView] = useState<"grouped" | "workspace" | "timeline">("workspace");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const [renaming, setRenaming] = useState<string | null>(null);
  // Groups collapse to the newest few sessions; expanded groups show all.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  // Make sure the active session's group is open. Retries until the sessions
  // list actually contains the session (it arrives after boot), then stops for
  // that session — a manual collapse is never overridden.
  const expandedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state.sessionFile || expandedFor.current === state.sessionFile) return;
    const label = groupSessions(state.sessions, state.projects, view, sort).find(([, items]) =>
      items.some((s) => s.path === state.sessionFile),
    )?.[0];
    if (label) {
      setExpanded((prev) => (prev.has(label) ? prev : new Set(prev).add(label)));
      expandedFor.current = state.sessionFile;
    }
  }, [state.sessionFile, state.sessions, state.projects, view, sort]);
  const _activeProject =
    state.projects.find((p) => p.path === state.cwd) ??
    (state.cwd ? { path: state.cwd, name: baseName(state.cwd) } : null);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      {window.pi.platform === "darwin" ? <div className="drag h-12 shrink-0" /> : null}
      <div
        className={cn(
          "drag flex h-12 shrink-0 items-center gap-2 pr-3",
          window.pi.platform === "darwin" ? "pl-20" : "pl-3",
        )}
      >
        {window.pi.platform !== "darwin" ? (
          <img alt="Pi" className="no-drag size-7 shrink-0 rounded-md" draggable={false} src={logo} />
        ) : null}
        <Button
          className="no-drag ml-auto"
          onClick={onOpenPalette}
          size="icon-sm"
          title="搜索（⌘K）"
          variant="ghost"
        >
          <SearchIcon />
        </Button>
        <Button className="no-drag" onClick={onOpenSkills} size="icon-sm" title="技能" variant="ghost">
          <WrenchIcon />
        </Button>
      </div>

      <div className="mb-1 flex items-center gap-1 px-2">
        <span className="text-[11px] font-medium text-muted-foreground">项目</span>
        <Button
          className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
          onClick={onCreateProject}
          size="sm"
          title="创建项目：选择文件夹并加入项目列表"
          variant="ghost"
        >
          <FolderPlusIcon className="size-3" />
          新建
        </Button>
      </div>

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
          {(() => {
            return (
              <>
                {state.sessions.length === 0 ? (
                  <p className="px-2 py-6 text-center text-muted-foreground text-xs">暂无任务</p>
                ) : null}
                {groupSessions(state.sessions, state.projects, view, sort).map(([label, items]) => {
            const open = view === "timeline" || expanded.has(label);
            const visible = open ? items : items.slice(0, COLLAPSED_COUNT);
            // 工作区视图：分组是项目，渲染成可折叠的项目标题（带目录图标）
            const isProject = view === "workspace";
            // 项目路径：优先从会话取；没有会话的项目从 projects 列表按名称反查
            const projectPath =
              items[0]?.cwd ??
              state.projects.find((p) => p.name === label)?.path ??
              null;
            const isActiveProject = isProject && projectPath === state.cwd;
            return (
            <div className="mb-0.5" key={label}>
              {isProject ? (
                <div className="group/project flex w-full items-center rounded-md transition-colors hover:bg-sidebar-accent">
                  <button
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-2 text-left text-xs",
                      isActiveProject && "font-medium text-foreground",
                    )}
                    onClick={() => {
                      // 双击项目标题 = 切换到该工作区
                      if (projectPath && projectPath !== state.cwd) openProject(projectPath);
                      else toggleGroup(label);
                    }}
                    title={projectPath ?? label}
                    type="button"
                  >
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {items.length > 0 ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground/60">
                        {items.length}
                      </span>
                    ) : null}
                    <ChevronDownIcon
                      className={cn(
                        "size-3 shrink-0 opacity-50 transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                  <button
                    className="mr-0.5 shrink-0 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover/project:text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 在该项目里开一个新会话（boot 到该 cwd 即全新会话）
                      if (projectPath) openProject(projectPath);
                    }}
                    title="新建会话"
                    type="button"
                  >
                    <MessageSquarePlusIcon className="size-3" />
                  </button>
                  <button
                    className="mr-1 shrink-0 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover/project:text-muted-foreground hover:text-destructive"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!projectPath) return;
                      if (!confirm(`从项目列表移除「${label}」？\n（会话文件不会被删除）`)) return;
                      await window.pi.projects.remove(projectPath).catch(() => null);
                      await onRemoveProject(projectPath);
                    }}
                    title="从列表移除（不删会话）"
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ) : (
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                  {label}
                </p>
              )}
              {items.length === 0 ? (
                <p className="px-2 py-1 pl-7 text-[10px] text-muted-foreground/60">暂无会话</p>
              ) : null}
              {open
                ? visible.map((s) => (
                    <div className={cn(isProject && "pl-3")} key={s.path}>
                      <TaskRow
                        active={state.sessionFile === s.path}
                        currentCwd={state.cwd}
                        key={s.path}
                        showProject={view !== "workspace"}
                        onDelete={() => deleteSession(s.path)}
                        onExport={() => window.pi.exportHtml()}
                        onOpen={() => openSession(s.path, s.cwd)}
                        onRename={(title) => {
                          if (s.path === state.sessionFile) renameSession(title);
                          else {
                            // Renaming applies to the live session: switch first.
                            Promise.resolve(openSession(s.path, s.cwd)).then(() => renameSession(title));
                          }
                        }}
                        onReveal={() => shellReveal(s.path)}
                        renaming={renaming === s.path}
                        session={s}
                        setRenaming={setRenaming}
                        streaming={state.sessionFile === s.path && state.isStreaming}
                      />
                    </div>
                  ))
                : null}
              {items.length > COLLAPSED_COUNT ? (
                <button
                  className="flex w-full items-center gap-1 rounded px-2 py-1 pl-7 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                  onClick={() => toggleGroup(label)}
                  type="button"
                >
                  <ChevronDownIcon
                    className={cn("size-3 transition-transform", open && "rotate-180")}
                  />
                  {open ? "收起" : `展开 ${items.length - COLLAPSED_COUNT} 个更早的会话`}
                </button>
              ) : null}
            </div>
            );
          })}
              </>
            );
          })()}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-1 border-t p-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-sidebar-accent"
          onClick={onOpenSettings}
          type="button"
        >
          <Settings2Icon className="size-4 shrink-0 text-muted-foreground" />
          设置
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">⌘K</span>
        </button>
        <Button
          onClick={onUpdateAction}
          size="icon-sm"
          title={updateTitle(update)}
          variant="ghost"
        >
          {update.status === "downloading" ? (
            <span className="font-mono text-[9px] tabular-nums">{update.percent}</span>
          ) : (
            <DownloadIcon
              className={cn(
                "size-4",
                update.status === "available" && "text-primary",
                update.status === "ready" && "text-primary",
              )}
            />
          )}
          {update.status === "available" || update.status === "ready" ? (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
        <Button
          onClick={onToggleTheme}
          size="icon-sm"
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          variant="ghost"
        >
          {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
        </Button>
      </div>
    </aside>
  );
}

function updateTitle(update: UpdateState) {
  const current = update.current ? `当前 v${update.current}` : "";
  switch (update.status) {
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return `已是最新（v${update.version ?? current}）`;
    case "available":
      return `有新版本 v${update.version}，点击下载`;
    case "downloading":
      return `下载中 ${update.percent}%`;
    case "ready":
      return `已下载 v${update.version}，点击重启安装`;
    case "error":
      return `检查/更新失败：${update.error ?? ""}（点击打开发布页）`;
    case "dev":
      return `${current}（开发模式不支持更新）`;
    default:
      return current ? `${current} · 检查更新` : "检查更新";
  }
}
