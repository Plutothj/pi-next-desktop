// 改动面板：agent 修改过的文件以 diff 视图展示（react-diff-viewer-continued），
// 每个文件可单独还原（git checkout HEAD --），支持全部还原（危险操作，二次确认）。
import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

type ChangeEntry = { path: string; untracked: boolean };
type DiffData = { patch: string; additions: number; deletions: number };

// git diff HEAD 输出 → 旧/新文本（react-diff-viewer 接收两端文本，自己算 diff）
function patchToTexts(patch: string): { old: string; new: string } {
  const lines = patch.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else {
      const ctx = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(ctx);
      newLines.push(ctx);
    }
  }
  return { old: oldLines.join("\n"), new: newLines.join("\n") };
}

const darkStyles = {
  variables: {
    dark: {
      diffViewerBackground: "transparent",
      diffViewerColor: "inherit",
      gutterBackground: "transparent",
      gutterBackgroundDark: "transparent",
      addedBackground: "rgba(34,197,94,0.12)",
      addedColor: "#4ade80",
      removedBackground: "rgba(239,68,68,0.12)",
      removedColor: "#f87171",
      wordAddedBackground: "rgba(34,197,94,0.25)",
      wordRemovedBackground: "rgba(239,68,68,0.25)",
      codeFoldGutterBackground: "transparent",
      codeFoldBackground: "rgba(255,255,255,0.03)",
      emptyLineBackground: "transparent",
      gutterColor: "rgba(255,255,255,0.2)",
      addedGutterColor: "#4ade80",
      removedGutterColor: "#f87171",
      codeFoldContentColor: "rgba(255,255,255,0.3)",
      diffViewerTitleBackground: "transparent",
      highlightBackground: "rgba(255,255,255,0.05)",
      highlightGutterBackground: "rgba(255,255,255,0.05)",
    },
  },
  line: { padding: "0 8px" },
};

export function ChangesPanel({
  cwd,
  changes,
  onReverted,
}: {
  cwd: string;
  changes?: ChangeEntry[];
  onReverted?: () => void;
}) {
  const [tab, setTab] = useState<"changes" | "tree">("changes");
  const [open, setOpen] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffData>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const list = changes ?? [];

  const fetchDiff = useCallback(
    async (file: string) => {
      const res = await window.pi.git.diff(cwd, file).catch(() => null);
      if (res?.ok) setDiffs((prev) => ({ ...prev, [file]: { patch: res.patch, additions: res.additions, deletions: res.deletions } }));
    },
    [cwd],
  );

  useEffect(() => {
    if (open && !diffs[open]) void fetchDiff(open);
  }, [open, diffs, fetchDiff]);

  const revert = async (file: string) => {
    const ok = await confirm({
      title: `还原 ${file}？`,
      description: "该文件的修改将丢失，无法撤销。",
      confirmText: "还原",
      destructive: true,
    });
    if (!ok) return;
    setBusy(file);
    await window.pi.git.revertFile(cwd, file).catch(() => null);
    setBusy(null);
    setOpen(null);
    onReverted?.();
  };

  const revertAll = async () => {
    const ok = await confirm({
      title: "全部还原？",
      description: `${list.length} 个文件的修改将丢失（untracked 文件会被删除），无法撤销。`,
      confirmText: "全部还原",
      destructive: true,
    });
    if (!ok) return;
    setBusy("__all__");
    await window.pi.git.revertAll(cwd).catch(() => null);
    setBusy(null);
    setOpen(null);
    onReverted?.();
  };

  if (!list.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        没有改动
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1">
        <span className="flex-1 truncate text-[12px] font-semibold text-muted-foreground">
          改动 · {list.length}
        </span>
        <Button
          className="h-6 px-1.5 text-[10px] text-destructive"
          disabled={busy === "__all__"}
          onClick={revertAll}
          size="sm"
          title="还原全部修改（危险）"
          variant="ghost"
        >
          <RotateCcwIcon className="mr-0.5 size-2.5" />
          全部还原
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {list.map(({ path, untracked }) => {
          const isOpen = open === path;
          const d = diffs[path];
          return (
            <div key={path}>
              <button
                className={cn(
                  "flex h-7 w-full items-center gap-1 rounded px-1.5 text-left text-[12px] hover:bg-accent/50",
                  isOpen && "bg-accent/30",
                )}
                onClick={() => setOpen(isOpen ? null : path)}
                type="button"
              >
                <ChevronDownIcon
                  className={cn("size-2.5 shrink-0 opacity-40 transition-transform", !isOpen && "-rotate-90")}
                />
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-muted-foreground">
                    {path.slice(0, path.lastIndexOf("/") + 1)}
                  </span>
                  {path.slice(path.lastIndexOf("/") + 1)}
                </span>
                {untracked ? (
                  <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-500">新</span>
                ) : null}
                {d ? (
                  <span className="shrink-0 font-mono text-[10px]">
                    <span className="text-emerald-500">+{d.additions}</span>{" "}
                    <span className="text-rose-500">-{d.deletions}</span>
                  </span>
                ) : null}
              </button>

              {isOpen ? (
                <div className="mb-2 overflow-hidden rounded-lg border">
                  {!d ? (
                    <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3 animate-spin" />
                      加载 diff…
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-end gap-1 border-b px-1 py-0.5">
                        <Button
                          className="h-5 px-1.5 text-[10px] text-destructive"
                          disabled={busy === path}
                          onClick={() => revert(path)}
                          size="sm"
                          variant="ghost"
                        >
                          <RotateCcwIcon className="mr-0.5 size-2" />
                          还原此文件
                        </Button>
                      </div>
                      <div className="max-h-80 overflow-auto font-mono text-[11px]">
                        <ReactDiffViewer
                          compareMethod={DiffMethod.WORDS}
                          hideLineNumbers
                          oldValue={patchToTexts(d.patch).old}
                          showDiffOnly
                          splitView={false}
                          styles={darkStyles}
                          newValue={patchToTexts(d.patch).new}
                          useDarkTheme
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
