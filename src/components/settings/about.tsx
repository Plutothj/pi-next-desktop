// 版本页：当前版本 + 应用内检查更新（与左下角下载图标共用同一 updater 状态）。
import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUpdater } from "@/hooks/useUpdater";
import { Section } from "./shared";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card/40 px-5 py-3.5">
      <div className="min-w-0 flex-1 text-sm">{label}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function AboutPanel() {
  const updater = useUpdater();
  const { status, current, version, percent, error } = updater.state;
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    await updater.check().catch(() => null);
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <Section hint="版本信息与应用内更新。更新在后台下载，完成后重启安装。" title="版本">
        <Row label={`当前版本${current ? `（v${current}）` : ""}`}>
          <Badge className="text-[11px]" variant="outline">
            Pi Desktop
          </Badge>
        </Row>
        <Row label="检查更新">
          <Button
            className="h-7 gap-1.5 text-xs"
            disabled={busy || status === "checking" || status === "downloading"}
            onClick={check}
            size="sm"
            variant="outline"
          >
            {busy || status === "checking" ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : null}
            {status === "checking" ? "检查中…" : "检查更新"}
          </Button>
        </Row>
        {status === "up-to-date" ? (
          <Row label="更新状态">
            <span className="text-xs text-emerald-600">已是最新版本</span>
          </Row>
        ) : null}
        {status === "available" ? (
          <Row label={`发现新版本 v${version ?? ""}`}>
            <Button
              className="h-7 text-xs"
              onClick={() => void updater.download().catch(() => null)}
              size="sm"
            >
              立即下载
            </Button>
          </Row>
        ) : null}
        {status === "downloading" ? (
          <Row label={`正在下载 v${version ?? "新版本"}`}>
            <span className="font-mono text-xs">{percent}%</span>
          </Row>
        ) : null}
        {status === "ready" ? (
          <Row label={`v${version ?? "新版本"} 已下载`}>
            <Button className="h-7 text-xs" onClick={updater.install} size="sm">
              立即重启安装
            </Button>
          </Row>
        ) : null}
        {status === "error" ? (
          <Row label="更新失败">
            <span className="line-clamp-1 text-xs text-destructive">{error ?? "未知错误"}</span>
            <Button className="h-7 text-xs" onClick={updater.openReleases} size="sm" variant="outline">
              发布页
            </Button>
          </Row>
        ) : null}
        {status === "dev" ? (
          <Row label="开发模式">
            <span className="text-xs text-muted-foreground">不支持应用内更新</span>
            <Button className="h-7 text-xs" onClick={updater.openReleases} size="sm" variant="outline">
              发布页
            </Button>
          </Row>
        ) : null}
      </Section>
    </div>
  );
}
