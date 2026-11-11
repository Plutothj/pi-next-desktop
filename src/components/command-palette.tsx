import { useEffect, useState } from "react";
import {
  BotIcon,
  FilesIcon,
  KeyboardIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  Minimize2Icon,
  PlusIcon,
  Settings2Icon,
  StethoscopeIcon,
  TerminalIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { SessionInfo } from "@/lib/pi";

type SearchHit = { path: string; title: string; cwd: string | null; mtime: number; snippet: string };
import { baseName } from "@/lib/utils";

export type PanelTab = "files" | "terminal" | "agents" | "browser" | "board" | "tree" | "plan";

/** ⌘K palette, modelled on ZCode's command center. */
export function CommandPalette({
  open,
  onOpenChange,
  actions,
  sessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: {
    newSession: () => void;
    compact: () => void;
    pickFolder: () => void;
    settings: () => void;
    panel: (tab: PanelTab) => void;
    openSession: (path: string, cwd?: string) => void;
    shortcuts: () => void;
    diagnostics: () => void;
    checkUpdate: () => void;
  };
  sessions: SessionInfo[];
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  // ⌘K 里输入 ≥2 个字时做全量会话全文搜索（SQLite FTS5，不读文件）
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      window.pi
        .searchSessions(text)
        .then((r) => {
          if (alive) setHits(r.hits.slice(0, 8));
        })
        .catch(() => null);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandInput onValueChange={setQuery} placeholder="搜索会话全文或命令…" value={query} />
      <CommandList>
        <CommandEmpty>没有匹配的结果</CommandEmpty>
        {hits.length > 0 ? (
          <CommandGroup heading="全文匹配">
            {hits.map((hit) => (
              <CommandItem
                key={`hit-${hit.path}`}
                onSelect={run(() => actions.openSession(hit.path, hit.cwd ?? undefined))}
                value={`${hit.title} ${hit.path} ${query} ${hit.snippet}`}
              >
                <MessageSquareIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {hit.title}
                  <span className="ml-2 text-[10px] text-muted-foreground">{hit.snippet}</span>
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {baseName(hit.cwd ?? "")}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="任务">
          {sessions.slice(0, 30).map((s) => (
            <CommandItem
              key={s.path}
              onSelect={run(() => actions.openSession(s.path, s.cwd))}
              value={`${s.title} ${s.cwd} ${s.id}`}
            >
              <MessageSquareIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {baseName(s.cwd)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="会话">
          <CommandItem onSelect={run(actions.newSession)}>
            <PlusIcon className="size-3.5" /> 新建会话
          </CommandItem>
          <CommandItem onSelect={run(actions.compact)}>
            <Minimize2Icon className="size-3.5" /> 压缩上下文
          </CommandItem>
          <CommandItem onSelect={run(actions.pickFolder)}>
            <FilesIcon className="size-3.5" /> 打开文件夹…
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="面板">
          <CommandItem onSelect={run(() => actions.panel("files"))}>
            <FilesIcon className="size-3.5" /> 显示文件
          </CommandItem>
          <CommandItem onSelect={run(() => actions.panel("terminal"))}>
            <TerminalIcon className="size-3.5" /> 显示终端 / 后台任务
          </CommandItem>
          <CommandItem onSelect={run(() => actions.panel("agents"))}>
            <BotIcon className="size-3.5" /> 显示子智能体
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="设置">
          <CommandItem onSelect={run(actions.settings)}>
            <Settings2Icon className="size-3.5" /> 打开设置
          </CommandItem>
          <CommandItem onSelect={run(actions.shortcuts)}>
            <KeyboardIcon className="size-3.5" /> 快捷键
          </CommandItem>
          <CommandItem onSelect={run(actions.checkUpdate)}>
            <RefreshCwIcon className="size-3.5" /> 检查更新
          </CommandItem>
          <CommandItem onSelect={run(actions.diagnostics)}>
            <StethoscopeIcon className="size-3.5" /> 导出诊断信息…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
