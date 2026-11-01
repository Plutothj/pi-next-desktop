import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PaletteIcon } from "lucide-react";
import { Section } from "./shared";
export function AppearancePanel() {
  const [theme, setTheme] = useState(localStorage.getItem("pi-theme") ?? "dark");

  const apply = (next: string) => {
    setTheme(next);
    localStorage.setItem("pi-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  return (
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
  );
}

// ------------------------------------------------------------- persona

