import { useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
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
import { cn } from "@/lib/utils";
import type {
  CfgSnapshot,
  FetchedModel,
  ProviderInfo,
  ProviderModel,
  ProviderModelCost,
} from "@/lib/pi";
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


// 每个模型一行的结构化草稿；显示名与 ID 相同时留空。
// contextWindow/maxTokens/cost 来自 models.dev 元数据：编辑时静默保存，不占版面。
type ModelDraft = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ProviderModelCost;
  effort?: string[];
};

const toDrafts = (models: ProviderModel[] | undefined): ModelDraft[] =>
  (models ?? []).map((m) => ({
    id: m.id,
    name: m.name && m.name !== m.id ? m.name : "",
    reasoning: Boolean(m.reasoning),
    image: (m.input ?? ["text"]).includes("image"),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
  }));

const fmtTokens = (n?: number) => {
  if (!n) return "";
  return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1_000)}k`;
};

const fmtCost = (c?: ProviderModelCost) => (c ? `$${c.input}/$${c.output}` : "");

// 行悬浮提示：上下文 / 输出上限 / 价格 / 推理档位
const draftTip = (r: ModelDraft) =>
  [
    r.contextWindow ? `上下文 ${r.contextWindow.toLocaleString()}` : "",
    r.maxTokens ? `最大输出 ${r.maxTokens.toLocaleString()}` : "",
    r.cost ? `价格 $${r.cost.input}/$${r.cost.output} 每 Mtok` : "",
    r.effort?.length ? `推理档位 ${r.effort.join("/")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

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
  const [rows, setRows] = useState<ModelDraft[]>(() => toDrafts(initial?.models));
  // 「获取模型列表」的结果与勾选状态
  const [available, setAvailable] = useState<FetchedModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [fetching, setFetching] = useState(false);

  const updateRow = (index: number, patch: Partial<ModelDraft>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const fetchList = async () => {
    setFetching(true);
    setLog(null);
    const res = await window.pi.cfg.fetchModels({
      name: name.trim(),
      api,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || undefined,
    });
    setFetching(false);
    if (!res.ok || !res.models?.length) {
      setLog(res.error ?? "未获取到模型");
      return;
    }
    setAvailable(res.models);
    // 默认勾选本地还没有的模型
    setPicked(
      new Set(
        res.models
          .map((m) => m.id)
          .filter((id) => !rows.some((r) => r.id === id)),
      ),
    );
    setFilter("");
    const enriched = res.models.filter(
      (m) => m.cost != null || m.contextWindow != null || m.reasoningEffort != null,
    ).length;
    setLog(
      `获取到 ${res.models.length} 个模型${enriched ? `，${enriched} 个带 models.dev 元数据` : ""}，勾选后添加`,
    );
  };

  const visible = (available ?? []).filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  });
  const visibleIds = visible.map((m) => m.id);
  const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (allVisiblePicked) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const addPicked = () => {
    const chosen = (available ?? []).filter(
      (m) => picked.has(m.id) && !rows.some((r) => r.id === m.id),
    );
    if (chosen.length) {
      setRows((prev) => [
        ...prev,
        ...chosen.map((m) => ({
          id: m.id,
          name: m.name && m.name !== m.id ? m.name : "",
          reasoning: Boolean(m.reasoning),
          image: Boolean(m.image),
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost,
          effort: m.reasoningEffort,
        })),
      ]);
    }
    setAvailable(null);
    setPicked(new Set());
    setFilter("");
  };

  const save = async () => {
    setSaving(true);
    setBusy(true);
    setLog(null);
    // 同 ID 去重，空行忽略
    const seen = new Set<string>();
    const list = rows.flatMap((r) => {
      const id = r.id.trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          name: r.name.trim() || id,
          reasoning: r.reasoning,
          input: r.image ? ["text", "image"] : ["text"],
          contextWindow: r.contextWindow,
          maxTokens: r.maxTokens,
          cost: r.cost,
        },
      ];
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

  const canSave = Boolean(name.trim()) && (Boolean(initial) || rows.some((r) => r.id.trim()));

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

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">模型（{rows.length}）</span>
          <div className="flex gap-1">
            <Button
              className="h-7 gap-1 text-xs"
              disabled={fetching}
              onClick={fetchList}
              size="sm"
              variant="ghost"
            >
              {fetching ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              获取模型列表
            </Button>
            <Button
              className="h-7 gap-1 text-xs"
              onClick={() => setRows((prev) => [...prev, { id: "", name: "", reasoning: false, image: false }])}
              size="sm"
              variant="ghost"
            >
              <PlusIcon className="size-3" /> 手动添加
            </Button>
          </div>
        </div>

        {available ? (
          <div className="rounded-md border bg-background/60 p-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 text-xs"
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`筛选（共 ${available.length} 个）`}
                value={filter}
              />
              <Button className="h-7 text-xs" onClick={toggleAllVisible} size="sm" variant="ghost">
                {allVisiblePicked ? "全不选" : "全选"}
              </Button>
              <Button className="h-7 text-xs" disabled={!picked.size} onClick={addPicked} size="sm">
                添加所选（{picked.size}）
              </Button>
              <Button
                aria-label="关闭"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setAvailable(null);
                  setPicked(new Set());
                }}
                size="sm"
                variant="ghost"
              >
                ✕
              </Button>
            </div>
            <div className="max-h-44 space-y-0.5 overflow-auto">
              {visible.map((m) => {
                const meta = [
                  m.reasoning ? "推理" : "",
                  m.image ? "图片" : "",
                  fmtTokens(m.contextWindow),
                  fmtCost(m.cost),
                  m.reasoningEffort?.length ? `档位 ${m.reasoningEffort.join("/")}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/60"
                    key={m.id}
                    title={meta}
                  >
                    <input
                      checked={picked.has(m.id)}
                      className="accent-primary size-3.5"
                      onChange={() => togglePick(m.id)}
                      type="checkbox"
                    />
                    <span className="truncate font-mono">{m.id}</span>
                    {meta ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{meta}</span>
                    ) : null}
                    {m.name && m.name !== m.id ? (
                      <span className="ml-auto shrink-0 truncate pl-2 text-muted-foreground">
                        {m.name}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              {!visible.length ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配模型</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {rows.length ? (
          <div className="space-y-1.5">
            {rows.map((row, i) => (
              <div className="flex items-center gap-1.5" key={i} title={draftTip(row)}>
                <Input
                  aria-label="模型 ID"
                  className="h-8 flex-1 font-mono text-xs"
                  onChange={(e) => updateRow(i, { id: e.target.value })}
                  placeholder="模型 ID，如 deepseek-chat"
                  value={row.id}
                />
                <Input
                  aria-label="显示名"
                  className="h-8 w-28 shrink-0 text-xs"
                  onChange={(e) => updateRow(i, { name: e.target.value })}
                  placeholder="显示名（可选）"
                  value={row.name}
                />
                {row.contextWindow ? (
                  <span className="w-9 shrink-0 text-center text-[10px] text-muted-foreground">
                    {fmtTokens(row.contextWindow)}
                  </span>
                ) : null}
                <FlagChip
                  active={row.reasoning}
                  label="推理"
                  onClick={() => updateRow(i, { reasoning: !row.reasoning })}
                />
                <FlagChip
                  active={row.image}
                  label="图片"
                  onClick={() => updateRow(i, { image: !row.image })}
                />
                <Button
                  aria-label="删除模型"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            尚未添加模型：点「获取模型列表」从供应商拉取，或「手动添加」。
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button className="h-7 text-xs" onClick={onCancel} size="sm" variant="ghost">
          取消
        </Button>
        <Button className="h-7 text-xs" disabled={saving || !canSave} onClick={save} size="sm">
          {saving ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}

// 模型能力开关：推理 / 图片
function FlagChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "h-8 w-10 shrink-0 rounded-md border text-[11px] transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent/60",
      )}
      onClick={onClick}
      title={active ? `已启用${label}输入，点击关闭` : `启用${label}输入`}
      type="button"
    >
      {label}
    </button>
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

