import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  MessageSquarePlusIcon,
  MoonIcon,
  SearchIcon,
  Settings2Icon,
  SunIcon,
  WrenchIcon,
} from "lucide-react";
import logo from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
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
import { baseName, cn } from "@/lib/utils";
import type { State } from "@/hooks/usePi";
import type { UpdateState } from "@/lib/pi";

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
  onNewSession,
  onOpenPalette,
  onOpenSkills,
  onOpenSettings,
  onToggleTheme,
  openProject,
  openSession,
  deleteSession,
  renameSession,
  update,
  onUpdateAction,
}: {
  state: State;
  theme: "dark" | "light";
  onNewSession: () => void;
  onOpenPalette: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  openProject: (path: string) => void;
  openSession: (path: string, cwd?: string) => void | Promise<void>;
  deleteSession: (path: string) => Promise<void>;
  renameSession: (title: string) => Promise<void>;
  update: UpdateState;
  onUpdateAction: () => void;
}) {
  const [view, setView] = useState<"grouped" | "workspace" | "timeline">("workspace");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const [renaming, setRenaming] = useState<string | null>(null);
  // 会话搜索：标题即时过滤 + 全文 grep（防抖 350ms，主进程扫最近 200 个文件）
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<
    { path: string; title: string; cwd: string | null; mtime: number; snippet: string }[] | null
  >(null);
  const [scanned, setScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // 全文搜索防抖；标题过滤在渲染时即时做
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const id = setTimeout(() => {
      window.pi.searchSessions(q).then((r) => {
        setHits(r.hits);
        setScanned(r.scanned);
        setTruncated(r.truncated);
      }).catch(() => setHits(null));
    }, 350);
    return () => clearTimeout(id);
  }, [search]);
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
  const activeProject =
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
          className="no-drag flex-1 justify-center gap-1.5 px-2"
          onClick={onNewSession}
          size="sm"
          title="新建任务"
          variant="secondary"
        >
          <MessageSquarePlusIcon className="size-3.5" />
          <span className="text-xs">新建任务</span>
        </Button>
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="mx-2 mb-2 h-8 justify-start gap-2 px-2.5 text-xs"
            title={activeProject?.path ?? "打开文件夹…"}
            variant="ghost"
          >
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {activeProject?.name ?? "选择项目"}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
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

      <div className="px-2 pb-1">
        <Input
          className="h-7 text-xs"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索会话"
          value={search}
        />
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
        {hits !== null ? (
          <div className="flex flex-col gap-px px-2 pb-2">
            {truncated ? (
              <p className="px-2 pt-2 pb-1 text-[10px] text-muted-foreground/60">结果较多，仅显示前 30 条</p>
            ) : null}
            {hits.length === 0 ? (
              <p className="px-2 py-6 text-center text-muted-foreground text-xs">
                无匹配会话{scanned ? `（已扫 ${scanned} 个）` : ""}
              </p>
            ) : null}
            {hits.map((h) => (
              <button
                className="rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent"
                key={h.path}
                onClick={() => openSession(h.path, h.cwd ?? undefined)}
                type="button"
              >
                <p className="truncate text-xs">{h.title}</p>
                <p className="line-clamp-2 text-[10px] text-muted-foreground/80">{h.snippet}</p>
              </button>
            ))}
          </div>
        ) : (
        <div className="flex flex-col gap-px px-2 pb-2">
          {(() => {
            const q = search.trim().toLowerCase();
            const visibleSessions =
              q && state.sessions.length
                ? state.sessions.filter((s) => s.title.toLowerCase().includes(q))
                : state.sessions;
            return (
              <>
                {visibleSessions.length === 0 ? (
                  <p className="px-2 py-6 text-center text-muted-foreground text-xs">暂无任务</p>
                ) : null}
                {groupSessions(visibleSessions, state.projects, view, sort).map(([label, items]) => {
            const open = view === "timeline" || expanded.has(label);
            const visible = open ? items : items.slice(0, COLLAPSED_COUNT);
            return (
            <div key={label}>
              <p className="px-2 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                {label}
              </p>
              {items.length === 0 ? (
                <p className="px-2 py-1 text-[10px] text-muted-foreground/60">暂无任务</p>
              ) : null}
              {visible.map((s) => (
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
              ))}
              {items.length > COLLAPSED_COUNT ? (
                <button
                  className="flex w-full items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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
        )}
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
