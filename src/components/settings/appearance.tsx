import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Section } from "./shared";

const ZOOM_STEPS = [1, 1.1, 1.25, 1.5, 1.75, 2];

export function AppearancePanel() {
  const [theme, setTheme] = useState(localStorage.getItem("pi-theme") ?? "dark");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    window.pi.zoomGet().then((f) => setZoom(f)).catch(() => {});
  }, []);

  const apply = (next: string) => {
    setTheme(next);
    localStorage.setItem("pi-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  const applyZoom = (factor: number) => {
    setZoom(factor);
    void window.pi.zoomSet(factor);
  };

  return (
    <div className="space-y-8">
      <Section hint="只影响界面外观，不影响对话内容。" title="主题">
        <div className="flex gap-2">
          {["dark", "light"].map((value) => (
            <Button
              className={cn("h-16 w-24 flex-col gap-1 text-xs", theme === value && "border-primary")}
              key={value}
              onClick={() => apply(value)}
              variant="outline"
            >
              <span
                className={cn(
                  "h-6 w-14 rounded-xl border bg-card/40",
                  value === "dark" ? "bg-zinc-900" : "bg-zinc-100",
                )}
              />
              {value === "dark" ? "深色" : "浅色"}
            </Button>
          ))}
        </div>
      </Section>

      <Section hint="界面整体缩放（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位），对所有窗口持久生效。" title="界面缩放">
        <div className="flex flex-wrap gap-1.5">
          {ZOOM_STEPS.map((f) => (
            <button
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                Math.abs(zoom - f) < 0.001
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
              key={f}
              onClick={() => applyZoom(f)}
              type="button"
            >
              {Math.round(f * 100)}%
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- persona

