import { useEffect } from "react";
import {
  BotIcon,
  FilesIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PlusIcon,
  Settings2Icon,
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
import { baseName } from "@/lib/utils";

export type PanelTab = "files" | "terminal" | "agents" | "browser";

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

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandInput placeholder="搜索任务或命令…" />
      <CommandList>
        <CommandEmpty>没有匹配的结果</CommandEmpty>
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
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
