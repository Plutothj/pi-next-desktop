import { useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ZapIcon,
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

// 常用供应商预设：一键填 id / baseUrl / 协议，配合「获取模型列表」即点即用
const PROVIDER_PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions" },
  { id: "moonshot", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
  { id: "dashscope", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  { id: "ollama", label: "Ollama（本地）", baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
];

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
                    已配置
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
// contextWindow/maxTokens/cost 默认来自 models.dev 元数据，可点行内「参数」chip 修改。
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

// "200k" / "1m" / "128000" → token 数；非法输入返回 undefined（不覆盖已存值）
const parseTokens = (s: string): number | undefined => {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return undefined;
  return Math.round(parseFloat(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
};

const fmtCost = (c?: ProviderModelCost) => (c ? `$${c.input}/$${c.output}` : "");

// 键值对 → headers 对象；空键忽略，全部为空时返回 undefined（表示不设置/清除）
const headersFromDrafts = (
  rows: { k: string; v: string }[],
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.k.trim();
    if (k) out[k] = r.v;
  }
  return Object.keys(out).length ? out : undefined;
};

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
  // 自定义请求头草稿（键值对）
  const [headerRows, setHeaderRows] = useState<{ k: string; v: string }[]>(() =>
    Object.entries(initial?.headers ?? {}).map(([k, v]) => ({ k, v })),
  );
  // 「获取模型列表」的结果与勾选状态
  const [available, setAvailable] = useState<FetchedModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [fetching, setFetching] = useState(false);
  // 展开参数编辑的行下标（上下文/输出上限/价格）
  const [paramsOpen, setParamsOpen] = useState<number | null>(null);

  const updateRow = (index: number, patch: Partial<ModelDraft>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  // 测试连接：向供应商 /models 端点发一次请求，验证 baseUrl + 密钥 + 网络
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await window.pi.cfg
      .fetchModels({ name: name.trim(), api, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
      .catch(() => null);
    setTesting(false);
    if (res?.ok && res.models?.length) {
      setTestResult(`✓ ${res.models.length} 个模型`);
      setTimeout(() => setTestResult(null), 3000);
    } else {
      const err = res && "error" in res ? res.error : "连接失败";
      setTestResult(`✗ ${err?.slice(0, 60)}`);
    }
  };

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
    const models = res.models;
    // 目录是元数据的权威来源：同步回填已有行（旧行/手动行的 200k 之类默认值在此纠正）。
    // 推理/图片开关仅在行没有元数据时才按目录纠正，不覆盖用户手动设置。
    setRows((prev) =>
      prev.map((r) => {
        const meta = models.find((m) => m.id === r.id.trim());
        if (!meta) return r;
        const enriched = r.contextWindow == null;
        return {
          ...r,
          contextWindow: meta.contextWindow ?? r.contextWindow,
          maxTokens: meta.maxTokens ?? r.maxTokens,
          cost: meta.cost ?? r.cost,
          effort: meta.reasoningEffort ?? r.effort,
          reasoning: enriched && meta.reasoning != null ? meta.reasoning : r.reasoning,
          image: enriched && meta.image != null ? meta.image : r.image,
        };
      }),
    );
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
      headers: headersFromDrafts(headerRows),
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
      {!initial ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">预设：</span>
          {PROVIDER_PRESETS.map((p) => (
            <button
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              key={p.id}
              onClick={() => {
                setName(p.id);
                setDisplayName(p.label);
                setBaseUrl(p.baseUrl);
                setApi(p.api);
              }}
              title={`填入 ${p.baseUrl}`}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
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

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            自定义请求头（可选，值支持 $ENV 环境变量引用）
          </span>
          <Button
            className="h-7 gap-1 text-xs"
            onClick={() => setHeaderRows((prev) => [...prev, { k: "", v: "" }])}
            size="sm"
            variant="ghost"
          >
            <PlusIcon className="size-3" /> 添加请求头
          </Button>
        </div>
        {headerRows.map((h, i) => (
          <div className="flex items-center gap-1.5" key={i}>
            <Input
              aria-label="请求头名称"
              className="h-8 w-40 shrink-0 font-mono text-xs"
              onChange={(e) =>
                setHeaderRows((prev) => prev.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
              }
              placeholder="Header 名称，如 X-Api-Key"
              value={h.k}
            />
            <Input
              aria-label="请求头值"
              className="h-8 flex-1 font-mono text-xs"
              onChange={(e) =>
                setHeaderRows((prev) => prev.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
              }
              placeholder="值（支持 $ENV / ${ENV} / !command）"
              value={h.v}
            />
            <Button
              aria-label="删除请求头"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setHeaderRows((prev) => prev.filter((_, j) => j !== i))}
              size="icon"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">模型（{rows.length}）</span>
          <div className="flex gap-1">
            <Button
              className="h-7 gap-1 text-xs"
              disabled={testing}
              onClick={testConnection}
              size="sm"
              variant="ghost"
            >
              {testing ? <Loader2Icon className="size-3 animate-spin" /> : <ZapIcon className="size-3" />}
              {testResult ?? "测试连接"}
            </Button>
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
              <div className="space-y-1" key={i}>
                <div className="flex items-center gap-1.5" title={draftTip(row)}>
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
                  <button
                    className={cn(
                      "h-8 min-w-9 shrink-0 rounded-md border px-1 text-[11px] transition-colors hover:bg-accent/60",
                      paramsOpen === i
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "text-muted-foreground",
                    )}
                    onClick={() => setParamsOpen(paramsOpen === i ? null : i)}
                    title="上下文 / 最大输出 / 价格，点击编辑"
                    type="button"
                  >
                    {row.contextWindow ? fmtTokens(row.contextWindow) : "参数"}
                  </button>
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
                    onClick={() => {
                      setRows((prev) => prev.filter((_, j) => j !== i));
                      setParamsOpen(null);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                {paramsOpen === i ? (
                  <ModelParamsEditor onChange={(patch) => updateRow(i, patch)} row={row} />
                ) : null}
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

// 模型参数编辑行（上下文 / 最大输出 / 价格）：本地字符串草稿，合法时同步回行数据。
// 不合法的中间态只留在输入框里，不覆盖已存值；清空即删除该参数。
function ModelParamsEditor({
  row,
  onChange,
}: {
  row: ModelDraft;
  onChange: (patch: Partial<ModelDraft>) => void;
}) {
  const [ctx, setCtx] = useState(row.contextWindow ? String(row.contextWindow) : "");
  const [max, setMax] = useState(row.maxTokens ? String(row.maxTokens) : "");
  const [ci, setCi] = useState(row.cost?.input != null ? String(row.cost.input) : "");
  const [co, setCo] = useState(row.cost?.output != null ? String(row.cost.output) : "");

  const applyTokens = (field: "contextWindow" | "maxTokens", v: string) => {
    if (field === "contextWindow") setCtx(v);
    else setMax(v);
    const t = v.trim();
    if (!t) return onChange({ [field]: undefined });
    const n = parseTokens(t);
    if (n != null) onChange({ [field]: n });
  };

  const applyCost = (field: "input" | "output", v: string) => {
    if (field === "input") setCi(v);
    else setCo(v);
    const t = v.trim();
    const n = t === "" ? undefined : Number(t);
    // 非数字的中间态不动已存值
    if (n != null && !Number.isFinite(n)) return;
    const input = field === "input" ? n : row.cost?.input;
    const output = field === "output" ? n : row.cost?.output;
    onChange({
      cost:
        input == null && output == null
          ? undefined
          : {
              input: input ?? 0,
              output: output ?? 0,
              cacheRead: row.cost?.cacheRead ?? 0,
              cacheWrite: row.cost?.cacheWrite ?? 0,
            },
    });
  };

  const inputCls = "h-7 w-20 border-transparent bg-muted/50 px-1.5 font-mono text-[11px] focus-visible:bg-background";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
      <label className="flex items-center gap-1">
        上下文
        <Input
          className={inputCls}
          onChange={(e) => applyTokens("contextWindow", e.target.value)}
          placeholder="如 200k / 1m"
          value={ctx}
        />
      </label>
      <label className="flex items-center gap-1">
        最大输出
        <Input
          className={inputCls}
          onChange={(e) => applyTokens("maxTokens", e.target.value)}
          placeholder="如 8k"
          value={max}
        />
      </label>
      <label className="flex items-center gap-1">
        价格 $/Mtok
        <Input
          className={cn(inputCls, "w-16")}
          onChange={(e) => applyCost("input", e.target.value)}
          placeholder="输入"
          value={ci}
        />
        <Input
          className={cn(inputCls, "w-16")}
          onChange={(e) => applyCost("output", e.target.value)}
          placeholder="输出"
          value={co}
        />
      </label>
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

