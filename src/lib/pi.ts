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
};

export type ProjectInfo = {
  path: string;
  name: string;
  sessions: number;
  mtime: number;
  stored: boolean;
  exists: boolean;
};

export type ProviderModel = {
  id: string;
  name: string;
  api?: string | null;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
};

export type ProviderInfo = {
  name: string;
  displayName: string;
  api: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
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
  start: (cwd?: string) => Promise<{
    state: Record<string, unknown> | null;
    models: ModelInfo[];
    messages: PiMessage[];
    cwd: string;
  }>;
  send: (payload: Record<string, unknown>) => Promise<unknown>;
  pickFolder: () => Promise<string | null>;
  reveal: (target: string) => Promise<void>;
  sessions: () => Promise<SessionInfo[]>;
  deleteSession: (filePath: string) => Promise<{ ok: boolean; switched?: boolean; error?: string }>;
  forkSessionAt: (entryId: string) => Promise<{ ok: boolean; sessionFile?: string; error?: string }>;
  respondUi: (
    id: string,
    values: { value?: string; cancelled?: boolean; confirmed?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  debugDialog: (dialog: Omit<UiDialogRequest, "id">) => Promise<{ ok: boolean; id: string }>;
  exportHtml: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  diagExport: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  projects: {
    list: () => Promise<ProjectInfo[]>;
    add: (dir: string) => Promise<{ ok: boolean; error?: string }>;
    remove: (dir: string) => Promise<{ ok: boolean }>;
  };
  files: (cwd: string, query: string) => Promise<string[]>;
  tree: (cwd: string, dir?: string) => Promise<TreeEntry[]>;
  readFile: (cwd: string, file: string) => Promise<{ content?: string; size?: number; error?: string }>;
  agents: (cwd?: string) => Promise<AgentProfile[]>;
  git: {
    status: (cwd: string) => Promise<GitStatus>;
    branches: (cwd: string) => Promise<{ branches: string[]; error?: string }>;
    checkout: (cwd: string, branch: string) => Promise<{ ok: boolean; error?: string }>;
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
    setSetting: (patch: Record<string, unknown>) => Promise<{ ok: boolean; restart?: boolean }>;
    gallery: (query?: string) => Promise<GalleryPackage[] | { error: string }>;
    readSkill: (file: string, cwd?: string) => Promise<string>;
    deleteSkill: (dir: string) => Promise<{ ok: boolean; error?: string; restart?: boolean }>;
    setResources: (source: string, disabled: Record<string, boolean>) => Promise<{ ok: boolean; restart?: boolean }>;
    setMcp: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
    savePersona: (payload: { scope: string; field: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
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

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextBlock => b?.type === "text")
    .map((b) => b.text)
    .join("");
};
