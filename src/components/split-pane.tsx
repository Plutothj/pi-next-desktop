import { Columns2Icon, XIcon } from "lucide-react";
import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionView } from "@/hooks/useSessionView";
import type { SessionInfo } from "@/lib/pi";
import { baseName, cn } from "@/lib/utils";

/**
 * 并排窗格：显示"另一个正在跑的会话"的实时转录，只读；点聚焦按钮把它
 * 换成活动会话，原活动会话留在右栏继续跑。这样两个会话可以同时看得见，
 * 也能一键互换输入焦点。
 */
export function SplitPane({
  file,
  cwd,
  activeFile,
  sessions,
  onFocus,
  onPick,
  onClose,
}: {
  file: string;
  cwd?: string;
  activeFile?: string;
  sessions: SessionInfo[];
  onFocus: (file: string, cwd?: string) => void;
  onPick: (file: string, cwd?: string) => void;
  onClose: () => void;
}) {
  const { state: view, loaded } = useSessionView(file, cwd);
  const info = sessions.find((s) => s.path === file);
  const title = info?.title || view.sessionName || file.split(/[\\/]/).pop() || "会话";
  const running = Boolean(view.isStreaming);
  const others = sessions.filter((s) => s.path !== file && s.path !== activeFile).slice(0, 12);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l" data-split-pane>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3 text-xs">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-amber-500" : "bg-muted-foreground/40",
          )}
          title={running ? "运行中" : "已完成"}
        />
        <span className="min-w-0 flex-1 truncate" title={file}>
          {title}
        </span>
        {info && info.cwd !== cwd ? (
          <span className="max-w-24 shrink-0 truncate rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">
            {baseName(info.cwd)}
          </span>
        ) : null}
        {others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="h-6 shrink-0 px-1.5 text-[11px]" size="sm" variant="ghost">
                切换
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-auto">
              {others.map((s) => (
                <DropdownMenuItem key={s.path} onSelect={() => onPick(s.path, s.cwd)}>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="ml-2 max-w-20 shrink-0 truncate text-[10px] text-muted-foreground">
                    {baseName(s.cwd)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          className="h-6 shrink-0 px-1.5 text-[11px]"
          onClick={() => onFocus(file, cwd)}
          size="sm"
          title="聚焦这个会话（原会话留在右栏继续跑）"
          variant="secondary"
        >
          <Columns2Icon className="size-3" />
          聚焦
        </Button>
        <Button
          className="h-6 shrink-0 px-1 text-muted-foreground"
          onClick={onClose}
          size="icon-sm"
          title="关闭并排"
          variant="ghost"
        >
          <XIcon className="size-3" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {loaded ? (
          <Chat state={view} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            正在读取会话…
          </div>
        )}
        <div className="shrink-0 px-4 pb-4">
          <button
            className="w-full rounded-lg border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            onClick={() => onFocus(file, cwd)}
            type="button"
          >
            点击聚焦这个会话，继续输入
          </button>
        </div>
      </div>
    </div>
  );
}
