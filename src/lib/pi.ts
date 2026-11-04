export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};

export type PiMessage = {
  role: "system" | "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary";
  content: string | ContentBlock[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number;
  // custom
  customType?: string;
  summary?: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number };
};

export type ToolExec = {
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: unknown;
  durationMs?: number;
};

export type QueueState = { steering: string[]; followUp: string[] };

export type RpcEvent = {
  type: string;
  id?: string;
  value?: boolean;
  agent?: BoardAgent;
  agentId?: string;
  rec?: RpcEvent;
  lines?: string[];
  placement?: "above" | "below";
  message?: PiMessage;
  usage?: Usage;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    id?: string;
    toolName?: string;
    toolCall?: ToolCallBlock;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  steering?: string[];
  followUp?: string[];
  errorMessage?: string;
  code?: number | null;
  signal?: string | null;
  chunk?: string;
  key?: string;
  text?: string;
  task?: TaskInfo;
  dialog?: UiDialogRequest;
  update?: UpdateState;
  message_text?: string;
  aborted?: boolean;
  reason?: string;
};

export type SessionInfo = {
  path: string;
  id: string;
  cwd: string;
  timestamp: string;
  title: string;
  mtime: number;
};

export type UpdateState = {
  status:
    | "idle"
    | "dev"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "ready"
    | "error";
  version: string | null;
  percent: number;
  error: string | null;
  current: string;
};

export type UsageEntry = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

export type UsageReport = {
  totals: UsageEntry;
  byModel: Array<UsageEntry & { model: string; provider: string; messages: number }>;
  byDay: Array<UsageEntry & { day: string; messages: number }>;
  sessions: number;
  assistantMessages: number;
};

export type UiDialogRequest = {
  id: string;
  method: "select" | "input" | "editor";
  title?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
};

export type GitStatus = {
  isRepo: boolean;
  branch?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  error?: string;
  changes?: { path: string; untracked: boolean }[];
};

export type ProjectInfo = {
  path: string;
  name: string;
  sessions: number;
  mtime: number;
  stored: boolean;
  exists: boolean;
};

export type ProviderModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ProviderModel = {
  id: string;
  name: string;
  api?: string | null;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ProviderModelCost;
};

// cfg:fetchModels 返回的模型：provider 端点数据 + models.dev 元数据合并
export type FetchedModel = {
  id: string;
  name: string;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ProviderModelCost;
  reasoningEffort?: string[];
};

export type ProviderInfo = {
  name: string;
  displayName: string;
  api: string | null;
  baseUrl: string | null;
  headers?: Record<string, string> | null;
  hasKey: boolean;
  custom: boolean;
  models: ProviderModel[];
};

export type PackageInfo = {
  source: string;
  root: string;
  installed: boolean;
  name: string;
  version?: string;
  description?: string;
  keywords: string[];
  resources: { extensions: number; skills: number; prompts: number; themes: number };
  disabled: { extensions: boolean; skills: boolean; prompts: boolean; themes: boolean };
};

export type SkillInfo = {
  name: string;
  description: string;
  path: string;
  dir: string;
  body: string;
  size: number;
  scope: "user" | "project" | "package";
  source: string;
};

export type GalleryPackage = {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  author?: string;
  date?: string;
  links?: Record<string, string>;
  source: string;
  installed: boolean;
};

export type McpServer = {
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  detail: string;
};

export type PromptTemplate = {
  name: string;
  scope: string;
  path: string;
  description: string;
  preview: string;
};

export type MemoryFile = {
  name: string;
  scope: string;
  path: string;
  size: number;
  preview: string;
};

export type PersonaFiles = {
  userSystem: string;
  userAppend: string;
  projectSystem: string;
  projectAppend: string;
};

export type CfgSnapshot = {
  settings: Record<string, unknown>;
  providers: ProviderInfo[];
  packages: PackageInfo[];
  skills: SkillInfo[];
  mcp: McpServer[];
  prompts: PromptTemplate[];
  memory: MemoryFile[];
  persona: PersonaFiles;
  apiKinds: string[];
  agentDir: string;
};

export type CommandInfo = {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string; scope?: string };
};

// 并行 agent 任务板的卡片
export type BoardAgent = {
  id: string;
  name: string;
  cwd: string;
  status: "running" | "done" | "failed" | "error";
  startedAt: number;
  endedAt: number | null;
  tail: string;
  sessionFile: string | null;
};

export type TaskInfo = {
  id: string;
  cmd: string;
  label: string;
  cwd: string;
  status: "running" | "done" | "failed";
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  output: string;
  origin?: "user" | "agent";
};

export type TreeEntry = { name: string; path: string; dir: boolean };

export type AgentProfile = {
  name: string;
  path: string;
  scope: "builtin" | "project";
  description: string;
  tools: string;
  model: string;
};

export type PiBridge = {
  switchSession: (
    sessionFile: string,
    cwd?: string,
  ) => Promise<{ ok: boolean; running?: boolean; error?: string }>;
  start: (cwd?: string) => Promise<{
    state: Record<string, unknown> | null;
    models: ModelInfo[];
    messages: PiMessage[];
    cwd: string;
  }>;
  send: (payload: Record<string, unknown>) => Promise<unknown>;
  pickFolder: () => Promise<string | null>;
  reveal: (target: string) => Promise<void>;
  getThinkingPrefs: () => Promise<Record<string, string>>;
  setThinkingPref: (payload: { provider: string; modelId: string; level: string }) => Promise<{ ok: boolean }>;
  showWindow: () => Promise<{ ok: boolean }>;
  platform: string;
  e2e: boolean;
  win: {
    minimize: () => Promise<{ ok: boolean }>;
    toggleMaximize: () => Promise<{ ok: boolean; maximized?: boolean }>;
    closeApp: () => Promise<{ ok: boolean }>;
    state: () => Promise<{ maximized: boolean }>;
  };
  schedules: {
    list: () => Promise<
      { id: string; name: string; time: string; cwd: string; message: string; enabled: boolean; lastRun: string | null }[]
    >;
    save: (payload: {
      id?: string;
      name?: string;
      time: string;
      cwd?: string;
      message: string;
      enabled?: boolean;
    }) => Promise<{ ok: boolean; error?: string }>;
    delete: (id: string) => Promise<{ ok: boolean }>;
  };
    board: {
    list: () => Promise<BoardAgent[]>;
    run: (payload: { name?: string; cwd?: string; message: string }) => Promise<BoardAgent>;
    stop: (id: string) => Promise<{ ok: boolean; error?: string }>;
    message: (id: string, message: string) => Promise<{ ok: boolean; error?: string }>;
    abort: (id: string) => Promise<{ ok: boolean; error?: string }>;
  };
  zoom: (delta: number) => Promise<{ ok: boolean; factor?: number }>;
  getPref: (key: string) => Promise<{ value: unknown }>;
  setPref: (key: string, value: unknown) => Promise<{ ok: boolean }>;
  zoomReset: () => Promise<{ ok: boolean; factor?: number }>;
  zoomSet: (factor: number) => Promise<{ ok: boolean; factor?: number; error?: string }>;
  zoomGet: () => Promise<number>;
  sessions: () => Promise<SessionInfo[]>;
  searchSessions: (query: string) =>
    Promise<{
      hits: { path: string; title: string; cwd: string | null; mtime: number; snippet: string }[];
      scanned: number;
      truncated: boolean;
    }>;
  deleteSession: (filePath: string) => Promise<{ ok: boolean; switched?: boolean; error?: string }>;
  forkSessionAt: (entryId: string) => Promise<{ ok: boolean; sessionFile?: string; error?: string }>;
  respondUi: (
    id: string,
    values: { value?: string; cancelled?: boolean; confirmed?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  parseAttachment: (payload: { name: string; dataBase64: string }) =>
    Promise<
      | { ok: true; kind: "text"; text: string }
      | { ok: true; kind: "zip"; dir: string; files: string[]; count: number }
      | { ok: false; error: string }
    >;
  debugDialog: (dialog: Omit<UiDialogRequest, "id">) => Promise<{ ok: boolean; id: string }>;
  debugWidget: (payload: { key?: string; lines: string[]; placement?: "above" | "below" }) => Promise<{ ok: boolean }>;
  debugQuit?: () => Promise<{ ok: boolean }>;
  exportHtml: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  diagExport: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  plans: {
    save: (cwd: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    list: (cwd: string) => Promise<{ path: string; name: string; mtime: number; size: number }[]>;
    read: (cwd: string, file: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
    delete: (cwd: string, file: string) => Promise<{ ok: boolean; error?: string }>;
  };
  stats: {
    usage: (days?: "all" | 7 | 30) => Promise<UsageReport>;
  };
  updater: {
    state: () => Promise<UpdateState>;
    check: () => Promise<UpdateState & { ok: boolean }>;
    download: () => Promise<UpdateState & { ok: boolean }>;
    install: () => Promise<{ ok: boolean; error?: string }>;
    openReleases: () => Promise<{ ok: boolean }>;
  };
  projects: {
    list: () => Promise<ProjectInfo[]>;
    add: (dir: string) => Promise<{ ok: boolean; error?: string }>;
    remove: (dir: string) => Promise<{ ok: boolean }>;
  };
  files: (cwd: string, query: string) => Promise<string[]>;
  tree: (cwd: string, dir?: string) => Promise<TreeEntry[]>;
  readFile: (cwd: string, file: string, abs?: string) => Promise<{ content?: string; size?: number; error?: string }>;
  pickPreview: () => Promise<{ ok: boolean; path?: string; name?: string; canceled?: boolean }>;
  debugApproveFile?: (abs: string) => Promise<{ ok: boolean }>;
  saveAttachment: (payload: { name: string; dataBase64: string }) => Promise<{
    ok: boolean;
    path?: string;
    name?: string;
    size?: number;
    error?: string;
  }>;
  recordAttachments: (payload: {
    cwd: string;
    ts: number;
    files: { name: string; path: string; kind?: string }[];
  }) => Promise<{ ok: boolean; error?: string }>;
  listAttachments: (cwd: string) => Promise<
    { ts: number; files: { name: string; path: string; kind: string }[] }[]
  >;
  readTable: (
    cwd: string,
    file: string,
    abs?: string,
  ) => Promise<{
    ok: boolean;
    sheets?: { name: string; rows: string[][]; truncatedRows?: boolean }[];
    truncatedSheets?: boolean;
    error?: string;
  }>;
  writeTable: (
    cwd: string,
    file: string,
    abs: string | undefined,
    sheetName: string,
    rows: string[][],
  ) => Promise<{ ok: boolean; bytes?: number; error?: string }>;
  readDoc: (cwd: string, file: string, abs?: string) => Promise<{ ok: boolean; html?: string; error?: string }>;
  readPdf: (cwd: string, file: string, abs?: string) => Promise<{ ok: boolean; data?: Uint8Array; error?: string }>;
  extractText: (cwd: string, file: string, abs?: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  agents: (cwd?: string) => Promise<AgentProfile[]>;
  git: {
    status: (cwd: string) => Promise<GitStatus>;
    branches: (cwd: string) => Promise<{ branches: string[]; error?: string }>;
    checkout: (cwd: string, branch: string) => Promise<{ ok: boolean; error?: string }>;
    diff: (cwd: string, file: string) => Promise<{ ok: boolean; patch: string; additions: number; deletions: number; error?: string }>;
    revertFile: (cwd: string, file: string) => Promise<{ ok: boolean; error?: string }>;
    revertAll: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  };
  term: {
    run: (cmd: string, cwd: string, label?: string, host?: string) => Promise<{ id: string; cwd: string }>;

    list: () => Promise<TaskInfo[]>;
    output: (id: string) => Promise<string>;
    kill: (id: string) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    hosts: () => Promise<string[]>;
  };
  cfg: {
    read: (cwd?: string) => Promise<CfgSnapshot>;
    saveProvider: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; restart?: boolean }>;
    deleteProvider: (name: string) => Promise<{ ok: boolean; restart?: boolean }>;
    fetchModels: (payload: {
      name?: string;
      api?: string;
      baseUrl?: string;
      apiKey?: string;
    }) => Promise<{ ok: boolean; models?: FetchedModel[]; error?: string }>;
    setSetting: (patch: Record<string, unknown>) => Promise<{ ok: boolean; restart?: boolean }>;
    gallery: (query?: string, from?: number) =>
      Promise<{ ok: boolean; items: GalleryPackage[]; total: number; error?: string }>;
    readSkill: (file: string, cwd?: string) => Promise<string>;
    deleteSkill: (dir: string) => Promise<{ ok: boolean; error?: string; restart?: boolean }>;
    setResources: (source: string, disabled: Record<string, boolean>) => Promise<{ ok: boolean; restart?: boolean }>;
    setMcp: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
    savePersona: (payload: { scope: string; field: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
    savePrompt: (payload: { scope: "user" | "project"; name: string; content: string; cwd?: string }) =>
      Promise<{ ok: boolean; error?: string; restart?: boolean }>;
    deletePrompt: (payload: { scope: "user" | "project"; name: string; cwd?: string }) =>
      Promise<{ ok: boolean; error?: string; restart?: boolean }>;
    readPrompt: (payload: { scope: "user" | "project"; name: string; cwd?: string }) => Promise<string>;
    install: (source: string) => Promise<{ ok: boolean; log?: string; error?: string }>;
    uninstall: (source: string) => Promise<{ ok: boolean; log?: string; error?: string }>;
  };
  onEvent: (fn: (record: RpcEvent) => void) => () => void;
};

declare global {
  interface Window {
    pi: PiBridge;
  }
}

export const blocksOf = (message: PiMessage): ContentBlock[] =>
  typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : (message.content ?? []);

export const lastAssistantTextOf = (messages: PiMessage[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = textOf(m.content).trim();
    if (text) return text;
  }
  return null;
};

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextBlock => b?.type === "text")
    .map((b) => b.text)
    .join("");
};
