import { useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CfgSnapshot, ProviderInfo } from "@/lib/pi";
import type { ApplyFn } from "./shared";

// extracted from settings-dialog.tsx
export function ProvidersPanel({
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
  const [editing, setEditing] = useState<ProviderInfo | "new" | null>(null);

  const remove = async (name: string) => {
    if (!confirm(`删除供应商 ${name} 及其密钥？`)) return;
    await onApply(await window.pi.cfg.deleteProvider(name));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {cfg.providers.length} 个供应商 · 保存后 pi 会重启
        </p>
        <Button className="h-9 gap-1.5 text-xs" onClick={() => setEditing("new")} size="sm">
          <PlusIcon className="size-3.5" /> 添加供应商
        </Button>
      </div>

      <div className="space-y-2">
        {cfg.providers.map((p) => (
          <div
            className="flex items-center gap-3 rounded-xl border bg-card/40 px-4 py-3"
            key={p.name}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{p.displayName}</span>
                {p.custom ? (
                  <Badge className="text-[11px]" variant="secondary">
                    自定义
                  </Badge>
                ) : null}
                {p.hasKey ? (
                  <Badge className="text-[11px]" variant="outline">
                    <CheckIcon className="mr-1 size-2.5" />
                    {p.keyHint ?? "已配置"}
                  </Badge>
                ) : (
                  <Badge className="text-[11px] text-destructive" variant="outline">
                    缺少密钥
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {p.models.length} 个模型 · {p.api ?? "未知协议"} · {p.baseUrl ?? "内置"}
              </p>
            </div>
            <Button className="h-9 px-3 text-xs" onClick={() => setEditing(p)} size="sm" variant="ghost">
              编辑
            </Button>
            <Button
              className="h-9 px-2 text-destructive"
              onClick={() => remove(p.name)}
              size="sm"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {editing ? (
        <ProviderForm
          apiKinds={cfg.apiKinds}
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onApply({ ok: true });
          }}
          onStatus={(msg, isBusy) => {
            setLog(msg);
            setBusy(isBusy);
          }}
          setBusy={setBusy}
          setLog={setLog}
        />
      ) : null}
    </div>
  );
}


function ProviderForm({
  initial,
  apiKinds,
  onSaved,
  onCancel,
  setBusy,
  setLog,
  onStatus,
}: {
  initial: ProviderInfo | null;
  apiKinds: string[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
  setBusy: (v: boolean) => void;
  setLog: (v: string | null) => void;
  onStatus: (msg: string, busy: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState(initial?.api ?? "openai-completions");
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState(
    (initial?.models ?? []).map((m) => m.id).join("\n"),
  );

  const save = async () => {
    setSaving(true);
    setBusy(true);
    setLog(null);
    const list = models
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, label, ...flags] = line.split(/[|,]/).map((s) => s.trim());
        return {
          id,
          name: label || id,
          reasoning: flags.includes("reasoning"),
          input: flags.includes("image") ? ["text", "image"] : ["text"],
        };
      });

    const res = await window.pi.cfg.saveProvider({
      name: name.trim(),
      displayName: displayName.trim() || name.trim(),
      api,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || undefined,
      models: list,
    });
    setSaving(false);
    setBusy(false);
    if (!res.ok) {
      setLog(res.error ?? "保存失败");
      return;
    }
    onStatus(`已保存 ${name}`, false);
    await onSaved();
  };

  return (
    <div className="space-y-4 rounded-md border bg-muted/20 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="供应商 ID">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setName(e.target.value)}
            placeholder="deepseek"
            value={name}
          />
        </Field>
        <Field label="显示名">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="DeepSeek"
            value={displayName}
          />
        </Field>
        <Field label="协议">
          <Select onValueChange={setApi} value={api}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {apiKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Base URL">
          <Input
            className="h-9 text-xs"
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            value={baseUrl}
          />
        </Field>
      </div>

      <Field label="API Key">
        <Input
          className="h-9 text-xs"
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial?.hasKey ? "已配置，留空则不修改" : "sk-…"}
          type="password"
          value={apiKey}
        />
      </Field>

      <Field label="模型（每行一个：id | 名称 | reasoning,image）">
        <Textarea
          className="min-h-20 font-mono text-xs"
          onChange={(e) => setModels(e.target.value)}
          placeholder={"deepseek-chat\n deepseek-reasoner | DeepSeek R1 | reasoning"}
          value={models}
        />
      </Field>

      <div className="flex justify-end gap-2">
        <Button className="h-7 text-xs" onClick={onCancel} size="sm" variant="ghost">
          取消
        </Button>
        <Button className="h-7 text-xs" disabled={saving || !name.trim()} onClick={save} size="sm">
          {saving ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// -------------------------------------------------------------- packages

