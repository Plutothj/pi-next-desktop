// 检查更新弹窗：点左下角下载图标打开。按 updater 状态实时渲染：
// 检查中 → 已最新 / 发现新版（自动开始下载）→ 下载进度 → 重启安装；失败可重试。
import { useEffect } from "react";
import { CheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useUpdater } from "@/hooks/useUpdater";

export function UpdateDialog({
  open,
  onOpenChange,
  updater,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updater: ReturnType<typeof useUpdater>;
}) {
  const { status, current, version, percent, error } = updater.state;

  // 用户主动点了「检查更新」：发现新版就直接开始下载，不用再点一次
  useEffect(() => {
    if (open && status === "available") updater.download();
  }, [open, status]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅随状态变化触发

  const retry = () => updater.check();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">软件更新</DialogTitle>
        </DialogHeader>

        {status === "checking" ? (
          <div className="flex items-center gap-2 py-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            正在检查更新…
          </div>
        ) : null}

        {status === "up-to-date" ? (
          <div className="flex items-center gap-2 py-2 text-sm">
            <CheckIcon className="size-4 text-emerald-500" />
            已是最新版本{current ? `（v${current}）` : ""}
          </div>
        ) : null}

        {status === "available" ? (
          <div className="flex items-center gap-2 py-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            发现新版本 v{version ?? ""}，正在下载…
          </div>
        ) : null}

        {status === "downloading" ? (
          <div className="space-y-2 py-2">
            <p className="text-sm">正在下载 v{version ?? "新版本"}… {percent}%</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
              />
            </div>
          </div>
        ) : null}

        {status === "ready" ? (
          <div className="py-2 text-sm">v{version ?? "新版本"} 已下载，重启应用以完成安装。</div>
        ) : null}

        {status === "error" ? (
          <div className="space-y-1.5 py-2">
            <p className="text-sm">更新失败</p>
            <p className="line-clamp-3 text-xs text-muted-foreground">{error ?? "未知错误"}</p>
          </div>
        ) : null}

        {status === "dev" ? (
          <div className="py-2 text-sm">
            开发模式不支持应用内更新{current ? `（当前 v${current}）` : ""}。
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          {status === "ready" ? (
            <>
              <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
                稍后
              </Button>
              <Button onClick={updater.install} size="sm">
                立即重启安装
              </Button>
            </>
          ) : null}
          {status === "error" ? (
            <>
              <Button onClick={updater.openReleases} size="sm" variant="ghost">
                查看发布页
              </Button>
              <Button onClick={retry} size="sm">
                <RefreshCwIcon className="mr-1 size-3" /> 重试
              </Button>
            </>
          ) : null}
          {status === "dev" ? (
            <Button onClick={updater.openReleases} size="sm">
              查看发布页
            </Button>
          ) : null}
          {status === "checking" || status === "available" || status === "downloading" ? (
            <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
              后台进行
            </Button>
          ) : null}
          {status === "up-to-date" ? (
            <Button onClick={() => onOpenChange(false)} size="sm">
              好
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
