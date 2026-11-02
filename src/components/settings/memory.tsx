import { useState } from "react";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CfgSnapshot, PromptTemplate } from "@/lib/pi";
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


type PromptDraft = { mode: "new" | "edit"; scope: "user" | "project"; name: string; content: string };

export function CommandsPanel({
  cfg,
  cwd,
  onApply,
  setBusy,
  setLog,
}: {
  cfg: CfgSnapshot;
  cwd: string;
  onApply: ApplyFn;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState<PromptDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const openEdit = async (prompt: PromptTemplate) => {
    try {
      const content = await window.pi.cfg.readPrompt({
        scope: prompt.scope === "project" ? "project" : "user",
        name: prompt.name,
        cwd,
      });
      setEditing({
        mode: "edit",
        scope: prompt.scope === "project" ? "project" : "user",
        name: prompt.name,
        content,
      });
    } catch (err) {
      setLog(`读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setBusy(true);
    setLog(null);
    const res = await window.pi.cfg.savePrompt({
      scope: editing.scope,
      name: editing.name.trim(),
      content: editing.content,
      cwd,
    });
    setSaving(false);
    setBusy(false);
    if (!res.ok) {
      setLog(res.error ?? "保存失败");
      return;
    }
    setLog(`已保存 /${editing.name.trim()}（重启会话后可调用）`);
    setEditing(null);
    await onApply({ ok: true });
  };

  const remove = async (prompt: PromptTemplate) => {
    if (!confirm(`删除命令 /${prompt.name}？`)) return;
    setBusy(true);
    const res = await window.pi.cfg.deletePrompt({
      scope: prompt.scope === "project" ? "project" : "user",
      name: prompt.name,
      cwd,
    });
    setBusy(false);
    if (!res.ok) {
      setLog(res.error ?? "删除失败");
      return;
    }
    setLog(`已删除 /${prompt.name}`);
    await onApply({ ok: true });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          自定义命令保存为 .md，输入框里 /名字 调用；用户级全局可用，项目级在当前工作区。
        </p>
        <Button
          className="h-7 shrink-0 gap-1 text-xs"
          onClick={() => setEditing({ mode: "new", scope: "user", name: "", content: "" })}
          size="sm"
          variant="outline"
        >
          <PlusIcon className="size-3" /> 新建命令
        </Button>
      </div>

      {editing ? (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">/</span>
              <Input
                className="h-8 w-44 font-mono text-xs"
                disabled={editing.mode === "edit"}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="命令名，如 review"
                value={editing.name}
              />
            </div>
            <div className="flex gap-1">
              {(["user", "project"] as const).map((scope) => (
                <button
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] transition-colors",
                    editing.scope === scope
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent/60",
                  )}
                  key={scope}
                  onClick={() => setEditing({ ...editing, scope })}
                  type="button"
                >
                  {scope === "user" ? "用户级" : "项目级"}
                </button>
              ))}
            </div>
          </div>
          <Textarea
            className="min-h-32 font-mono text-xs"
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            placeholder="命令内容（发给模型的提示词）。支持 frontmatter description: 一句话说明。"
            value={editing.content}
          />
          <div className="flex justify-end gap-2">
            <Button
              className="h-7 text-xs"
              onClick={() => setEditing(null)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              className="h-7 text-xs"
              disabled={saving || !editing.name.trim() || !editing.content.trim()}
              onClick={save}
              size="sm"
            >
              {saving ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {cfg.prompts.length === 0 && !editing ? (
        <p className="text-xs text-muted-foreground">还没有自定义命令，点「新建命令」创建一个。</p>
      ) : null}

      {cfg.prompts.map((prompt) => (
        <div className="rounded-xl border bg-card/40 px-4 py-3" key={prompt.path}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">/{prompt.name}</span>
            <Badge className="text-[11px]" variant="outline">
              {prompt.scope === "user" ? "用户级" : "项目级"}
            </Badge>
            <div className="ml-auto flex gap-1">
              <Button
                className="h-7 px-2 text-xs"
                onClick={() => openEdit(prompt)}
                size="sm"
                variant="ghost"
              >
                编辑
              </Button>
              <Button
                className="h-7 px-2 text-destructive"
                onClick={() => remove(prompt)}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon className="size-3" />
              </Button>
            </div>
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
const _ALIASES: Record<string, string> = {
  scout: "Explore · 代码库侦察",
  reviewer: "代码审查",
  delegate: "通用任务",
  worker: "实现",
  researcher: "调研",
  oracle: "决策顾问",
  "evidence-auditor": "证据审查",
};

