// 创建项目：项目名称 + 源文件夹（参照 ZCode 的对话框）。
// 名称只是显示用；pi 的工作目录是文件夹路径，会话按 cwd 归到项目下。
import { useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (dir: string, name?: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const picked = await window.pi.pickFolder().catch(() => null);
    if (picked) {
      setDir(picked);
      if (!name.trim()) setName(picked.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };

  const submit = async () => {
    if (!dir) return;
    setBusy(true);
    await onCreate(dir, name.trim() || undefined);
    setBusy(false);
    setName("");
    setDir("");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">创建项目</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="project-name">
              项目名称
            </label>
            <Input
              className="h-9 text-xs"
              id="project-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="新项目"
              value={name}
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">源文件夹</span>
            <button
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center transition-colors hover:border-primary/40 hover:bg-accent/30"
              onClick={pick}
              type="button"
            >
              <span className="rounded-full bg-muted p-2">
                <FolderOpenIcon className="size-4 text-muted-foreground" />
              </span>
              <span className="text-xs font-medium">{dir ? "更换文件夹" : "选择文件夹"}</span>
              <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground">
                {dir || "对话与文件操作都在这个目录下进行"}
              </span>
            </button>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            取消
          </Button>
          <Button disabled={!dir || busy} onClick={submit} size="sm">
            {busy ? "创建中…" : "创建项目"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
