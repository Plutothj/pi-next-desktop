// Reads and writes pi's user-level config: providers/models, packages, skills.
// Everything here is plain file I/O against ~/.pi/agent, no RPC involved.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR } from "./app-home.js";

export { AGENT_DIR };
const npmRoot = path.join(AGENT_DIR, "npm", "node_modules");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

export const readSettings = () => readJson(path.join(AGENT_DIR, "settings.json"), {});
export const writeSettings = (data) => writeJson(path.join(AGENT_DIR, "settings.json"), data);
export const readAuth = () => readJson(path.join(AGENT_DIR, "auth.json"), {});
export const readModelsJson = () => readJson(path.join(AGENT_DIR, "models.json"), {});
export const writeModelsJson = (data) => writeJson(path.join(AGENT_DIR, "models.json"), data);
const readStore = () => readJson(path.join(AGENT_DIR, "models-store.json"), {});

export const API_KINDS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "bedrock-converse-stream",
];

// ------------------------------------------------------------------ providers

export function listProviders() {
  const store = readStore();
  const custom = readModelsJson().providers ?? {};
  const auth = readAuth();
  const names = new Set([...Object.keys(store), ...Object.keys(custom), ...Object.keys(auth)]);

  return [...names].sort().map((name) => {
    const customProvider = custom[name];
    const storeModels = store[name]?.models ?? [];
    const customModels = customProvider?.models ?? [];
    const legacy = storeModels[0];
    return {
      name,
      displayName: customProvider?.name ?? name,
      api: customProvider?.api ?? legacy?.api ?? null,
      baseUrl: customProvider?.baseUrl ?? legacy?.baseUrl ?? null,
      headers: customProvider?.headers ?? null,
      hasKey: Boolean(auth[name]?.key || customProvider?.apiKey),
      keyHint: null,
      custom: Boolean(customProvider),
      models: (customModels.length ? customModels : storeModels).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: m.api ?? customProvider?.api ?? null,
        reasoning: Boolean(m.reasoning),
        input: m.input ?? ["text"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: m.cost,
      })),
    };
  });
}

// 密钥内容（含掩码片段）不再回传渲染层，列表只标 hasKey。

export function saveProvider({ name, displayName, api, baseUrl, apiKey, headers, models }) {
  if (!name) throw new Error("provider 名字不能为空");
  const config = readModelsJson();
  config.providers ??= {};

  const existing = config.providers[name] ?? {};
  const next = { ...existing, name: displayName || name, api, baseUrl };
  if (apiKey) next.apiKey = apiKey;
  // 请求头：值为字符串原样写入，pi 侧支持 $ENV / ${ENV} / !command 解析
  if (headers && Object.keys(headers).length) next.headers = headers;
  else delete next.headers;

  // An entry without id is invalid and makes pi drop the whole provider.
  // 同 id 去重保留首个（与渲染层编辑器的 seen-set 行为一致）。
  const list = (models ?? []).filter((m) => m?.id);
  const seen = new Set();
  const unique = list.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if (unique.length) {
    next.models = unique.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      api: m.api || api,
      baseUrl: m.baseUrl || baseUrl,
      reasoning: Boolean(m.reasoning),
      input: m.input ?? ["text"],
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 200000,
      maxTokens: m.maxTokens ?? 32000,
    }));
  } else if (existing.models) {
    next.models = existing.models;
  }

  config.providers[name] = next;
  writeModelsJson(config);
  return config.providers[name];
}

export function deleteProvider(name) {
  const config = readModelsJson();
  if (config.providers?.[name]) {
    delete config.providers[name];
    writeModelsJson(config);
  }
  const auth = readAuth();
  if (auth[name]) {
    delete auth[name];
    writeJson(path.join(AGENT_DIR, "auth.json"), auth);
  }
}

// ------------------------------------------------------------- model catalog

// models.dev：pi 生态共用的模型元数据库（推理、模态、上下文、价格、推理档位）。
// 供应商自己的 /models 端点大多只回 id，能力信息从这里补全。5MB 级别，进程内缓存 1 小时。
const MODEL_CATALOG_URL = "https://models.dev/api.json";
let catalogCache = null;

async function fetchCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < 3_600_000) {
    return catalogCache;
  }
  let db = null;
  // models.dev 偶发超时，重试一次
  for (let i = 0; i < 2 && !db; i++) {
    try {
      const res = await fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) db = await res.json();
    } catch {}
  }
  if (!db) throw new Error("models.dev 不可达");
  // 反查索引：modelId → 元数据（跨供应商同名 id 取首个）
  const index = new Map();
  for (const p of Object.values(db)) {
    for (const [id, meta] of Object.entries(p.models ?? {})) {
      if (!index.has(id)) index.set(id, meta);
    }
  }
  catalogCache = { at: Date.now(), providerModels: db, index };
  return catalogCache;
}

const slugOf = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const toCost = (c) =>
  c
    ? {
        input: c.input ?? 0,
        output: c.output ?? 0,
        cacheRead: c.cache_read ?? 0,
        cacheWrite: c.cache_write ?? 0,
      }
    : undefined;

// 先按供应商 slug 精确匹配（deepseek、openai…），再按模型 id 全目录兜底
function lookupCatalog(catalog, providerName, modelId) {
  const direct = catalog.providerModels[slugOf(providerName)]?.models?.[modelId];
  return direct ?? catalog.index.get(modelId) ?? null;
}

function enrichWithCatalog(catalog, providerName, m) {
  const meta = lookupCatalog(catalog, providerName, m.id);
  if (!meta) return m;
  return {
    ...m,
    name: m.name && m.name !== m.id ? m.name : (meta.name ?? m.name),
    reasoning: Boolean(meta.reasoning),
    image: (meta.modalities?.input ?? []).includes("image"),
    contextWindow: meta.limit?.context,
    maxTokens: meta.limit?.output,
    cost: toCost(meta.cost),
    reasoningEffort: meta.reasoning_options?.find((o) => o.type === "effort")?.values,
  };
}

const API_DEFAULT_BASE = {
  "openai-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
  "mistral-conversations": "https://api.mistral.ai/v1",
};

// 已存过的密钥（models.json 或 auth.json），编辑供应商时留空即复用。
const storedKey = (name) => {
  if (!name) return null;
  return (
    readModelsJson().providers?.[name]?.apiKey ?? readAuth()[name]?.key ?? null
  );
};

// 用户可能粘成完整端点，剥掉尾部的 /models、/chat/completions。
const normalizeBase = (raw) => {
  let base = String(raw ?? "").trim().replace(/\/+$/, "");
  base = base.replace(/\/(models|chat\/completions|messages)$/, "");
  return base;
};

// 拉取供应商的模型列表（/models 端点），让用户勾选而不是手写模型 id。
export async function fetchProviderModels({ name, api, baseUrl, apiKey } = {}) {
  if (api === "bedrock-converse-stream") {
    throw new Error("Bedrock 需要 AWS 凭证，无法直接拉取，请手动添加模型");
  }
  const key = apiKey || storedKey(name);
  if (!key) throw new Error("请先填写 API Key（或保存过密钥后留空）");
  const base = normalizeBase(baseUrl) || normalizeBase(API_DEFAULT_BASE[api]);
  if (!base) throw new Error("无法确定 Base URL，请先填写");

  let url = `${base}/models`;
  const headers = {};
  let pick = (data) =>
    (data.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));

  if (api === "anthropic-messages") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    pick = (data) =>
      (data.data ?? []).map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
      }));
  } else if (api === "google-generative-ai") {
    url = `${base}/models?key=${encodeURIComponent(key)}`;
    pick = (data) =>
      (data.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => ({
          id: String(m.name ?? "").replace(/^models\//, ""),
          name: m.displayName ?? m.name,
        }));
  } else {
    // openai 兼容（含 mistral）：统一 Bearer
    headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`获取模型列表失败 (${res.status})${body ? `: ${body}` : ""}`);
  }
  const list = pick(await res.json()).filter((m) => m.id);
  if (!list.length) throw new Error("该端点未返回任何模型");
  // 合并 models.dev 元数据；目录不可达不影响主流程
  try {
    const catalog = await fetchCatalog();
    return list.map((m) => enrichWithCatalog(catalog, name, m));
  } catch {
    return list;
  }
}

// --------------------------------------------------------------- packages

const packagePath = (source) => {
  const spec = source.replace(/^npm:/, "").split("@").slice(0, -1).join("@") || source;
  const bare = source.startsWith("npm:") ? source.slice(4) : spec;
  const dir = bare.startsWith("@") ? bare.split("@").slice(0, 2).join("@") : bare.split("@")[0];
  return path.join(npmRoot, dir);
};

const kindOf = (file) => (file.startsWith("@") ? path.join(...file.split("/")) : file);

function resourcesOf(root, manifest) {
  const pi = manifest?.pi ?? {};
  const pick = (key, dirs) => {
    const declared = pi[key];
    if (Array.isArray(declared) && declared.length) {
      return declared
        .filter((p) => !p.startsWith("!"))
        .flatMap((p) => {
          const full = path.join(root, p);
          try {
            return fs.statSync(full).isDirectory()
              ? fs.readdirSync(full).map((f) => path.join(full, f))
              : [full];
          } catch {
            return [];
          }
        });
    }
    return dirs.flatMap((d) => {
      try {
        return fs
          .readdirSync(path.join(root, d))
          .map((f) => path.join(root, d, f))
          .filter((f) => !path.basename(f).startsWith("."));
      } catch {
        return [];
      }
    });
  };

  return {
    extensions: pick("extensions", ["extensions"]),
    skills: pick("skills", ["skills"]),
    prompts: pick("prompts", ["prompts"]),
    themes: pick("themes", ["themes"]),
  };
}

export function listPackages() {
  const settings = readSettings();
  const entries = (settings.packages ?? []).map((p) =>
    typeof p === "string" ? { source: p } : p,
  );

  return entries.map((entry) => {
    const source = entry.source ?? String(entry);
    const root = packagePath(source);
    const manifest = readJson(path.join(root, "package.json"), null);
    const resources = resourcesOf(root, manifest);

    // settings.packages object form can turn individual resource kinds off.
    const enabled = (kind) => actual(entry, kind, resources);

    return {
      source,
      root,
      installed: Boolean(manifest),
      name: manifest?.name ?? source,
      version: manifest?.version,
      description: manifest?.description,
      keywords: manifest?.keywords ?? [],
      resources: {
        extensions: resources.extensions.length,
        skills: resources.skills.length,
        prompts: resources.prompts.length,
        themes: resources.themes.length,
      },
      disabled: {
        extensions: !enabled("extensions"),
        skills: !enabled("skills"),
        prompts: !enabled("prompts"),
        themes: !enabled("themes"),
      },
    };
  });
}

function actual(entry, kind, resources) {
  if (!resources[kind].length) return true;
  const key = kind === "extensions" ? "extensions" : kind;
  if (!Array.isArray(entry[key])) return true;
  return entry[key].length > 0;
}

export function setPackageResources(source, disabledKinds) {
  const settings = readSettings();
  const entries = (settings.packages ?? []).map((p) =>
    typeof p === "string" ? { source: p } : { ...p },
  );
  const index = entries.findIndex((e) => e.source === source);
  if (index === -1) throw new Error(`未安装: ${source}`);

  const entry = entries[index];
  for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    if (disabledKinds[kind]) entry[kind] = [];
    else delete entry[kind];
  }
  entries[index] = Object.keys(entry).length > 1 ? entry : { source };
  settings.packages = entries;
  writeSettings(settings);
}

export function removePackageEntry(source) {
  const settings = readSettings();
  settings.packages = (settings.packages ?? []).filter(
    (p) => (typeof p === "string" ? p : p.source) !== source,
  );
  writeSettings(settings);
}

// ------------------------------------------------------------------ skills

function readSkillMeta(dir) {
  const file = path.join(dir, "SKILL.md");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const field = (key) => fm?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const name = field("name") ?? path.basename(dir);
  const description = field("description") ?? "";
  return { name, description, path: file, dir, body: raw, size: raw.length };
}

function walkSkills(root, scope, sourceLabel) {
  const out = [];
  const visit = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const meta = readSkillMeta(dir);
      if (meta) out.push({ ...meta, scope, source: sourceLabel });
      return;
    }
    if (depth === 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) visit(path.join(dir, e.name), depth - 1);
    }
  };
  visit(root, 2);
  return out;
}

export function listSkills(cwd) {
  const seen = new Set();
  const all = [];
  const push = (skill) => {
    if (seen.has(skill.name)) return;
    seen.add(skill.name);
    all.push(skill);
  };

  walkSkills(path.join(AGENT_DIR, "skills"), "user", `${AGENT_DIR.replace(os.homedir(), "~")}/skills`).forEach(push);
  walkSkills(path.join(os.homedir(), ".agents", "skills"), "user", "~/.agents/skills").forEach(push);
  if (cwd) {
    walkSkills(path.join(cwd, ".pi", "skills"), "project", ".pi/skills").forEach(push);
  }

  for (const pkg of listPackages()) {
    for (const skillPath of fs.existsSync(pkg.root) ? [] : []) void skillPath;
  }
  // package skills: one level per declared skill dir
  for (const pkg of listPackages()) {
    const manifest = readJson(path.join(pkg.root, "package.json"), null);
    const dirs = manifest?.pi?.skills ?? ["skills"];
    for (const rel of dirs) {
      if (typeof rel !== "string" || rel.startsWith("!")) continue;
      const full = path.join(pkg.root, rel);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        for (const child of fs.readdirSync(full)) {
          walkSkills(path.join(full, child), "package", pkg.name).forEach(push);
        }
      } else {
        walkSkills(path.dirname(full), "package", pkg.name).forEach(push);
      }
    }
  }

  return all;
}

export function deleteSkill(dir) {
  const root = path.join(AGENT_DIR, "skills") + path.sep;
  if (!dir.startsWith(root)) {
    throw new Error("只能删除用户目录下的技能");
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- gallery

export async function searchGallery({ query, from = 0 } = {}) {
  const text = query?.trim() ? `${query} keywords:pi-package` : "keywords:pi-package";
  const res = await fetch(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=30&from=${Number(from) || 0}`,
  );
  if (!res.ok) throw new Error(`npm 搜索失败: ${res.status}`);
  const data = await res.json();
  const installed = new Set(
    (readSettings().packages ?? []).map((p) => (typeof p === "string" ? p : p.source)),
  );

  const items = data.objects
    .map(({ package: p }) => ({
      name: p.name,
      version: p.version,
      description: p.description ?? "",
      keywords: p.keywords ?? [],
      author: p.author?.name ?? p.publisher?.username,
      date: p.date,
      links: p.links,
      source: `npm:${p.name}`,
    }))
    .filter((p) => p.keywords.includes("pi-package") || query?.trim())
    .map((p) => ({ ...p, installed: installed.has(p.source) }));
  return { items, total: data.total ?? items.length };
}


// ---------------------------------------------------------------- mcp / prompts / persona

const MCP_FILE = () => path.join(AGENT_DIR, "mcp.json");

export function listMcp() {
  const config = readJson(MCP_FILE(), { mcpServers: {} });
  return Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({
    name,
    enabled: server.enabled !== false,
    transport: server.url ? "http" : "stdio",
    detail: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" "),
    toolCount: server.exposeTools ? null : null,
  }));
}

export function setMcpEnabled(name, enabled) {
  const config = readJson(MCP_FILE(), { mcpServers: {} });
  const server = config.mcpServers?.[name];
  if (!server) return { ok: false, error: "找不到该 MCP 服务器" };
  config.mcpServers[name] = { ...server, enabled };
  writeJson(MCP_FILE(), config);
  return { ok: true };
}

export function listPrompts(cwd) {
  const dirs = [
    { dir: promptDir("user"), scope: "user" },
    { dir: promptDir("project", cwd), scope: "project" },
  ];
  const out = [];
  for (const { dir, scope } of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      let body = "";
      try { body = fs.readFileSync(full, "utf8"); } catch { continue; }
      out.push({
        name: file.replace(/\.md$/, ""),
        scope,
        path: full,
        description: body.match(/^---\n[\s\S]*?description:\s*(.+)$/m)?.[1]?.trim() ?? "",
        preview: body.replace(/^---[\s\S]*?---\n/, "").trim().slice(0, 200),
      });
    }
  }
  return out;
}

// ------------------------------------------------------- prompts: 读写/删除

const PROMPT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const promptDir = (scope, cwd) =>
  scope === "project"
    ? path.join(cwd ?? os.homedir(), ".pi", "prompts")
    : path.join(AGENT_DIR, "prompts");

// 文件名 stem 校验 + 落点守卫，供保存/读取/删除共用
const resolvePromptFile = (scope, name, cwd) => {
  const stem = String(name ?? "").trim();
  if (!PROMPT_NAME.test(stem)) throw new Error("命令名只能含字母/数字/中划线/下划线");
  const allowed = [promptDir("user"), promptDir("project", cwd)];
  const resolved = path.resolve(promptDir(scope, cwd), `${stem}.md`);
  if (!allowed.some((root) => resolved.startsWith(path.resolve(root) + path.sep))) {
    throw new Error("路径不在 prompts 目录内");
  }
  return resolved;
};

export function savePrompt({ scope, name, content, cwd } = {}) {
  if (scope !== "user" && scope !== "project") throw new Error("scope 必须是 user 或 project");
  if (typeof content !== "string" || !content.trim()) throw new Error("内容不能为空");
  const file = resolvePromptFile(scope, name, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return { ok: true, path: file };
}

export function deletePrompt({ scope, name, cwd } = {}) {
  const file = resolvePromptFile(scope, name, cwd);
  fs.rmSync(file, { force: true });
  return { ok: true };
}

export function readPrompt({ scope, name, cwd } = {}) {
  const file = resolvePromptFile(scope, name, cwd);
  const stat = fs.statSync(file);
  if (stat.size > 1_000_000) throw new Error("文件过大");
  return fs.readFileSync(file, "utf8");
}

export function listMemory() {
  const dirs = [
    { dir: path.join(AGENT_DIR, "memory"), scope: "memory" },
  ];
  const out = [];
  for (const { dir, scope } of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      let body = "";
      try { body = fs.readFileSync(full, "utf8"); } catch { continue; }
      out.push({ name: file, scope, path: full, size: body.length, preview: body.slice(0, 400) });
    }
  }
  return out;
}

const PERSONA_FILES = {
  system: "SYSTEM.md",
  append: "APPEND_SYSTEM.md",
};

export function readPersona(cwd) {
  const read = (file) => {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
  };
  return {
    userSystem: read(path.join(AGENT_DIR, PERSONA_FILES.system)),
    userAppend: read(path.join(AGENT_DIR, PERSONA_FILES.append)),
    projectSystem: read(path.join(cwd ?? os.homedir(), ".pi", PERSONA_FILES.system)),
    projectAppend: read(path.join(cwd ?? os.homedir(), ".pi", PERSONA_FILES.append)),
  };
}

export function writePersona({ scope, field, content }) {
  const file =
    field === "system" ? PERSONA_FILES.system : PERSONA_FILES.append;
  const dir = scope === "project" ? path.join(process.env.PI_CWD || os.homedir(), ".pi") : AGENT_DIR;
  const target = path.join(dir, file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { path as pathModule, kindOf };
