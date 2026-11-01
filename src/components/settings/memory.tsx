import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CfgSnapshot } from "@/lib/pi";
import type { ApplyFn } from "./shared";

// extracted from settings-dialog.tsx
export function MemoryPanel({ cfg }: { cfg: CfgSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{cfg.agentDir}/memory</p>
      {cfg.memory.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有记忆文件。</p>
      ) : null}
      {cfg.memory.map((file) => (
        <div className="rounded-xl border bg-card/40" key={file.path}>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/60"
            onClick={() => setOpen(open === file.path ? null : file.path)}
            type="button"
          >
            <span className="truncate text-xs">{file.name}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{file.size} 字</span>
          </button>
          {open === file.path ? (
            <pre className="max-h-64 overflow-auto border-t bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {file.preview}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}


export function McpPanel({
  cfg,
  onApply,
}: {
  cfg: CfgSnapshot;
  onApply: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        配置在 {cfg.agentDir}/mcp.json，改动后重启会话生效。
      </p>
      {cfg.mcp.map((server) => (
        <div className="flex items-center gap-3 rounded-xl border bg-card/40 px-4 py-3" key={server.name}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{server.name}</span>
              <Badge className="text-[11px]" variant="outline">
                {server.transport}
              </Badge>
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{server.detail}</p>
          </div>
          <Button
            className="h-7 text-xs"
            onClick={() =>
              onApply(
                window.pi.cfg.setMcp(server.name, !server.enabled).then(
                  (r) => r ?? { ok: true },
                ) as never,
              )
            }
            size="sm"
            variant={server.enabled ? "secondary" : "outline"}
          >
            {server.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      ))}
    </div>
  );
}


export function CommandsPanel({ cfg }: { cfg: CfgSnapshot }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        在 ~/.pi-desktop/agent/prompts 或 .pi/prompts 放 .md 文件，输入框里用 /名字 调用。
      </p>
      {cfg.prompts.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有自定义命令。</p>
      ) : null}
      {cfg.prompts.map((prompt) => (
        <div className="rounded-xl border bg-card/40 px-4 py-3" key={prompt.path}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">/{prompt.name}</span>
            <Badge className="text-[11px]" variant="outline">
              {prompt.scope === "user" ? "用户级" : "项目级"}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {prompt.description || prompt.preview}
          </p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- agents / stats / projects

/** Same roles ZCode shows (Explore / code review / general purpose), pi's names on the right. */
const ALIASES: Record<string, string> = {
  scout: "Explore · 代码库侦察",
  reviewer: "代码审查",
  delegate: "通用任务",
  worker: "实现",
  researcher: "调研",
  oracle: "决策顾问",
  "evidence-auditor": "证据审查",
};

