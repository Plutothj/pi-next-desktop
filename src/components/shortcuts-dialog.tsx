import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SHORTCUTS: [string, string][] = [
  ["⌘K", "搜索任务 / 命令"],
  ["⌘N", "新建任务"],
  ["Enter", "发送（流式中为排队）"],
  ["Shift+Enter", "换行"],
  ["Option+Enter", "流式中立即插入（steer）"],
  ["/", "命令弹窗"],
  ["@", "引用文件"],
  ["Esc", "关闭弹层 / 取消扩展对话框"],
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">快捷键</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          {SHORTCUTS.map(([keys, label]) => (
            <div className="flex items-center justify-between gap-4 text-xs" key={keys}>
              <span className="text-muted-foreground">{label}</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
