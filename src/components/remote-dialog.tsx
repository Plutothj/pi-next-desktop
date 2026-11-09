import { CopyIcon, ExternalLinkIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Notice = { message: string; notifyType?: string; at: number };

/**
 * 内置远程访问面板：驱动内置的 pi-mobile 扩展。
 * 命令都通过 pi 的扩展命令通道执行（"/remote" 不会进入模型回合）。
 */
export function RemoteDialog({
  open,
  onOpenChange,
  status,
  notice,
  onCommand,
  ready,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status?: string;
  notice?: Notice;
  onCommand: (command: string) => void;
  ready: boolean;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const urls = useMemo(() => {
    const found = notice?.message.match(/https:\/\/[^\s<>"')]+/gu) ?? [];
    return [...new Set(found)];
  }, [notice?.message]);
  const primary = urls.find((url) => url.includes("pair")) ?? urls[0];

  useEffect(() => {
    let alive = true;
    if (!primary) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(primary, { margin: 1, width: 224, color: { dark: "#000000", light: "#ffffff" } })
      .then((data) => {
        if (alive) setQr(data);
      })
      .catch(() => {
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [primary]);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  const copy = async () => {
    if (!primary) return;
    await navigator.clipboard.writeText(primary).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SmartphoneIcon className="size-4" />
            远程访问
          </DialogTitle>
          <DialogDescription>
            用手机浏览器扫码即可继续当前电脑上的会话：看进度、发消息、回答审批、切换会话。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium">状态</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={status}>
            {status || "未开启"}
          </span>
        </div>

        {primary ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border bg-card/40 p-4">
            <span className="text-xs text-muted-foreground">手机扫码配对（一次性）</span>
            {qr ? <img alt="配对二维码" className="size-56" src={qr} /> : null}
            <p className="max-w-full break-all rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {primary}
            </p>
            <div className="flex gap-2">
              <Button className="h-7 gap-1 px-2 text-xs" onClick={copy} size="sm" variant="secondary">
                <CopyIcon className="size-3" />
                {copied ? "已复制" : "复制链接"}
              </Button>
              <Button asChild className="h-7 gap-1 px-2 text-xs" size="sm" variant="ghost">
                <a href={primary} rel="noreferrer" target="_blank">
                  <ExternalLinkIcon className="size-3" />
                  打开
                </a>
              </Button>
            </div>
          </div>
        ) : null}

        {notice?.message ? (
          <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {notice.message}
          </div>
        ) : null}

        {!primary ? (
          <div className="rounded-lg border border-dashed px-3 py-2 text-xs leading-5 text-muted-foreground">
            手机必须通过 <span className="font-medium text-foreground">HTTPS</span> 访问。推荐在电脑和手机上安装
            Tailscale（同一 tailnet），点「开启远程」会自动配置；也可以在自己的 HTTPS 反代地址里填写
            <span className="font-mono"> /remote settings </span>。
          </div>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          <Button
            className="h-7 px-2 text-xs"
            disabled={!ready}
            onClick={() => onCommand("/remote")}
            size="sm"
          >
            开启远程
          </Button>
          <Button className="h-7 px-2 text-xs" onClick={() => onCommand("/remote pair")} size="sm" variant="secondary">
            配对新设备
          </Button>
          <Button className="h-7 px-2 text-xs" onClick={() => onCommand("/remote devices")} size="sm" variant="ghost">
            设备管理
          </Button>
          <Button className="h-7 px-2 text-xs" onClick={() => onCommand("/remote settings")} size="sm" variant="ghost">
            设置
          </Button>
          <Button
            className="h-7 px-2 text-xs text-destructive"
            onClick={() => onCommand("/remote off")}
            size="sm"
            variant="ghost"
          >
            关闭远程
          </Button>
        </div>

        <p className="text-[11px] leading-4 text-muted-foreground">
          二维码/链接是私密凭据，不要转发；每台手机单独配对，可在「设备管理」里随时撤销。远程服务只监听本机
          回环地址，通过 Tailscale 或你自己的 HTTPS 反代访问，不暴露公网端口。
        </p>
      </DialogContent>
    </Dialog>
  );
}
