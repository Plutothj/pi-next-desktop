import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CfgSnapshot } from "@/lib/pi";

// extracted from settings-dialog.tsx
export function SkillsPanel({
  cfg,
  cwd,
  onApply,
}: {
  cfg: CfgSnapshot;
  cwd: string;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const [preview, setPreview] = useState<{ name: string; body: string } | null>(null);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof cfg.skills>();
    for (const s of cfg.skills) {
      const key = s.scope === "package" ? s.source : s.scope === "user" ? "用户" : "项目";
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [cfg.skills]);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">{cfg.skills.length} 个技能</p>
      {grouped.map(([group, skills]) => (
        <section className="space-y-2" key={group}>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {group}
          </h3>
          {skills.map((s) => (
            <div className="flex items-center gap-2 rounded-xl border bg-card/40 px-4 py-3" key={s.dir}>
              <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{s.name}</span>
                <p className="line-clamp-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
              <Button
                className="h-9 px-3 text-xs"
                onClick={async () =>
                  setPreview({ name: s.name, body: await window.pi.cfg.readSkill(s.path, cwd) })
                }
                size="sm"
                variant="ghost"
              >
                预览
              </Button>
              {s.scope === "user" ? (
                <Button
                  className="h-9 px-2 text-destructive"
                  onClick={async () => {
                    if (!confirm(`删除技能 ${s.name}？`)) return;
                    const res = await window.pi.cfg.deleteSkill(s.dir);
                    if (res.ok) await onApply({ ok: true });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ))}

      <Dialog onOpenChange={(v: boolean) => !v && setPreview(null)} open={Boolean(preview)}>
        <DialogContent className="max-h-[70vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.name}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh]">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5">{preview?.body}</pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------- general

