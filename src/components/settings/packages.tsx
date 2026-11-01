import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  BoxesIcon,
  DownloadIcon,
  Loader2Icon,
  PackageIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CfgSnapshot, GalleryPackage } from "@/lib/pi";
import type { ApplyFn } from "./shared";

// extracted from settings-dialog.tsx
export function PackagesPanel({
  cfg,
  setBusy,
  setLog,
  onApply,
}: {
  cfg: CfgSnapshot;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [gallery, setGallery] = useState<GalleryPackage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [view, setView] = useState<"installed" | "market">("installed");

  const search = async (text: string) => {
    setSearching(true);
    const res = await window.pi.cfg.gallery(text);
    setSearching(false);
    if (Array.isArray(res)) setGallery(res);
    else {
      setGallery([]);
      setLog(res.error);
    }
  };

  useEffect(() => {
    search("");
  }, []);

  const install = async (source: string) => {
    setInstalling(source);
    setBusy(true);
    setLog(`安装 ${source}…`);
    const res = await window.pi.cfg.install(source);
    setBusy(false);
    setInstalling(null);
    if (!res.ok) setLog(res.log ?? res.error ?? "安装失败");
    else setLog(`已安装 ${source}`);
    await onApply({ ok: true });
    search(query);
  };

  const uninstall = async (source: string) => {
    if (!confirm(`卸载 ${source}？`)) return;
    setBusy(true);
    setLog(`卸载 ${source}…`);
    const res = await window.pi.cfg.uninstall(source);
    setBusy(false);
    setLog(res.ok ? `已卸载 ${source}` : (res.log ?? "卸载失败"));
    await onApply({ ok: true });
  };

  const toggleResource = async (
    source: string,
    disabled: Record<string, boolean>,
    kind: string,
  ) => {
    await window.pi.cfg.setResources(source, { ...disabled, [kind]: !disabled[kind] });
    await onApply({ ok: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-lg bg-muted/40 p-1">
        {(["installed", "market"] as const).map((key) => (
          <button
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs",
              view === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
            )}
            key={key}
            onClick={() => setView(key)}
            type="button"
          >
            {key === "installed" ? `已安装 ${cfg.packages.length}` : "扩展市场"}
          </button>
        ))}
      </div>

      {view === "installed" ? (
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">已安装（{cfg.packages.length}）</h3>
          <Button
            className="h-6 px-2 text-[11px]"
            onClick={() => onApply({ ok: true })}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon className="mr-1 size-3" /> 刷新
          </Button>
        </div>
        <div className="space-y-2">
          {cfg.packages.map((p) => (
            <div className="rounded-xl border bg-card/40 px-4 py-3" key={p.source}>
              <div className="flex items-center gap-2">
                <PackageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{p.name}</span>
                {p.version ? (
                  <Badge className="text-[11px]" variant="outline">
                    v{p.version}
                  </Badge>
                ) : null}
                <Button
                  className="ml-auto h-6 px-2 text-destructive"
                  onClick={() => uninstall(p.source)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
              {p.description ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(["extensions", "skills", "prompts", "themes"] as const).map((kind) =>
                  p.resources[kind] > 0 ? (
                    <button
                      className={cn(
                        "rounded-xl border bg-card/40 px-1.5 py-0.5 text-[11px] transition-colors",
                        p.disabled[kind]
                          ? "text-muted-foreground line-through"
                          : "bg-accent/60 text-foreground",
                      )}
                      key={kind}
                      onClick={() => toggleResource(p.source, p.disabled, kind)}
                      type="button"
                    >
                      {labelOf(kind)} {p.resources[kind]}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      ) : null}

      {view === "market" ? (
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">扩展市场</h3>
          <div className="ml-auto flex items-center gap-1">
            <Input
              className="h-7 w-44 text-xs"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search(query)}
              placeholder="搜索 npm pi-package…"
              value={query}
            />
            <Button
              className="h-7 px-2"
              disabled={searching}
              onClick={() => search(query)}
              size="sm"
              variant="outline"
            >
              {searching ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <BoxesIcon className="size-3" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {gallery === null ? (
            <p className="text-muted-foreground text-xs">加载中…</p>
          ) : gallery.length === 0 ? (
            <p className="text-muted-foreground text-xs">没有结果</p>
          ) : null}
          {gallery?.map((g) => (
            <div className="flex items-start gap-3 rounded-xl border bg-card/40 px-4 py-3" key={g.name}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{g.name}</span>
                  <Badge className="text-[11px]" variant="outline">
                    v{g.version}
                  </Badge>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{g.description}</p>
              </div>
              <Button
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                disabled={g.installed || installing === g.source}
                onClick={() => install(g.source)}
                size="sm"
                variant={g.installed ? "ghost" : "outline"}
              >
                {installing === g.source ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3" />
                )}
                {g.installed ? "已安装" : "安装"}
              </Button>
            </div>
          ))}
        </div>
      </section>
      ) : null}
    </div>
  );
}


const labelOf = (kind: string) =>
  ({ extensions: "扩展", skills: "技能", prompts: "提示", themes: "主题" })[kind] ?? kind;

// ---------------------------------------------------------------- skills

