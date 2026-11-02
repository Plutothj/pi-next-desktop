import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CfgSnapshot } from "@/lib/pi";

// extracted from settings-dialog.tsx
export function PersonaPanel({
  cfg,
  setLog,
}: {
  cfg: CfgSnapshot;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
  setLog: (v: string | null) => void;
}) {
  const [scope, setScope] = useState<"user" | "project">("user");
  const [field, setField] = useState<"system" | "append">("append");
  const initial = scope === "user" ? cfg.persona.userAppend : cfg.persona.projectAppend;
  const value =
    scope === "user"
      ? field === "system"
        ? cfg.persona.userSystem
        : cfg.persona.userAppend
      : field === "system"
        ? cfg.persona.projectSystem
        : cfg.persona.projectAppend;
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        SYSTEM.md 替换默认系统提示；APPEND_SYSTEM.md 追加在后面。用户级作用于所有项目。
      </p>
      <div className="flex gap-2">
        <Select onValueChange={(v) => setScope(v as "user" | "project")} value={scope}>
          <SelectTrigger className="h-9 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="text-xs" value="user">
              用户级
            </SelectItem>
            <SelectItem className="text-xs" value="project">
              项目级
            </SelectItem>
          </SelectContent>
        </Select>
        <Select onValueChange={(v) => setField(v as "system" | "append")} value={field}>
          <SelectTrigger className="h-9 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="text-xs" value="append">
              APPEND_SYSTEM.md
            </SelectItem>
            <SelectItem className="text-xs" value="system">
              SYSTEM.md
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          className="ml-auto h-8 text-xs"
          onClick={async () => {
            const res = await window.pi.cfg.savePersona({
              scope,
              field,
              content: draft ?? value,
            });
            setLog(res.ok ? "已保存，重启后会生效" : (res.error ?? "保存失败"));
            setDraft(null);
          }}
          size="sm"
        >
          保存
        </Button>
      </div>
      <Textarea
        className="min-h-[60vh] font-mono text-[13px] leading-6"
        onChange={(e) => setDraft(e.target.value)}
        placeholder="这里写内容…"
        value={draft ?? value ?? initial}
      />
    </div>
  );
}

// ------------------------------------------------------------- memory / mcp / commands

