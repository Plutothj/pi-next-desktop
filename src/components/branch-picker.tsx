import { useEffect, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { GitStatus } from "@/lib/pi";

/** ZCode-style branch chip above the composer: shows HEAD, click to switch. */
export function BranchPicker({
  git,
  cwd,
  onSwitched,
}: {
  git: GitStatus;
  cwd: string;
  onSwitched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    window.pi.git
      .branches(cwd)
      .then((res) => setBranches(res.branches))
      .catch(() => setBranches([]));
  }, [open, cwd]);

  const switchTo = async (branch: string) => {
    if (branch === git.branch) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const res = await window.pi.git
      .checkout(cwd, branch)
      .catch((err) => ({ ok: false, error: String(err) }));
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "切换失败");
      return;
    }
    setOpen(false);
    onSwitched();
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={git.dirty ? "当前分支有未提交的修改" : "切换分支"}
          type="button"
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="max-w-48 truncate font-mono">{git.branch}</span>
          {git.dirty ? (
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="有未提交的修改" />
          ) : null}
          {git.ahead ? (
            <span className="flex shrink-0 items-center gap-0.5 text-emerald-600">
              <ArrowUpIcon className="size-2.5" />
              {git.ahead}
            </span>
          ) : null}
          {git.behind ? (
            <span className="flex shrink-0 items-center gap-0.5 text-rose-500">
              <ArrowDownIcon className="size-2.5" />
              {git.behind}
            </span>
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" side="top">
        <Command>
          <CommandInput placeholder="搜索分支…" />
          <CommandList className="max-h-64">
            <CommandEmpty>没有匹配的分支</CommandEmpty>
            <CommandGroup heading={busy ? "切换中…" : "本地分支"}>
              {branches.map((branch) => (
                <CommandItem key={branch} onSelect={() => switchTo(branch)} value={branch}>
                  <GitBranchIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch}</span>
                  {branch === git.branch ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {error ? (
          <p className="max-h-32 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-destructive text-[11px]">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
