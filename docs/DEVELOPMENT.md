# Pi Desktop 开发文档

> 面向维护者的完整说明：架构、模块、协议、IPC、功能实现、持久化、调试与已知风险。
> 对应分支 `feat/zcode-parity`（4 个提交）。最后更新：2026-10-31。

---

## 1. 概览

Pi Desktop 是 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的桌面客户端：
**Electron 外壳 + React 界面 + `pi --mode rpc` 子进程**。外壳不实现 agent 循环，
只负责运行时管理、会话/项目组织、UI 与几项增强能力（git、后台任务、双模型编排）。

```
┌─────────────────────────────── Electron 主进程 ───────────────────────────────┐
│  main.js          窗口 / 生命周期 / pi 子进程 / 扩展 UI 协议桥                  │
│  pi-process.js    运行时解析、版本、CLI 能力探测、RPC 子进程（PiProcess）        │
│  sessions.js      会话扫描/标题、删除、文件级 fork、导出 HTML                    │
│  projects.js      projects.json 持久化                                         │
│  git.js           分支状态/列表/切换（直接调 git）                              │
│  tasks.js         后台任务表 + 本地桥（Unix socket / 命名管道）+ pi-bg CLI      │
│  workspace.js     文件搜索/树/预览、子智能体、SSH 主机                          │
│  config-ipc.js    ~/.pi/agent 配置读写、pi install/uninstall                    │
│  diag.js          日志环 + 导出诊断                                             │
│  ipc.js           safeHandle：统一参数校验、错误日志                            │
└───────────────┬──────────────────────────────────────────┬────────────────────┘
                │ ipcRenderer.invoke / webContents.send      │ stdio JSONL
                ▼                                            ▼
┌──────────────────────────── 渲染进程 ───────────────┐   ┌───────────────────────┐
│  App.tsx（Shell：侧边栏/顶栏/对话/输入框）            │   │  pi --mode rpc        │
│  hooks/usePi.ts（RPC 事件 → 单一 reducer 状态）       │   │  （agent 本体）        │
│  hooks/useGit.ts / useSessionStats / useTheme /      │   └──────────┬────────────┘
│         useDualModel                                 │              │ 子进程
│  components/*（chat、composer、面板、对话框）          │              ▼
└───────────────────┬─────────────────────────────────┘   ┌───────────────────────┐
                    │ pi-bg CLI（agent 的 bash 工具调用）    │ 后台任务（zsh/cmd）    │
                    └──────────── 本地 socket ──────────────▶│ 终端面板任务表         │
                                                           └───────────────────────┘
```

关键原则：

- **pi 是唯一的事实来源**（agent 状态、会话内容）；外壳只缓存并增量更新
- 渲染层通过 `window.pi`（preload contextBridge）访问主进程，不直接接触 Node
- 主进程不做 agent 决策，只做编排与 I/O

---

## 2. 目录结构

```
electron/
  main.js            入口：窗口、生命周期、pi 启动、扩展 UI 协议
  preload.cjs        contextBridge → window.pi（渲染层唯一 API 面）
  pi-process.js      运行时定位、版本、能力探测、PiProcess（RPC 子进程）
  sessions.js        会话目录扫描、标题解析、删除、fork、导出
  projects.js        项目列表（projects.json）
  git.js             git status/branches/checkout
  tasks.js           后台任务表、本地桥、pi-bg 安装
  workspace.js       files:* / agents:list / ssh:hosts
  config-ipc.js      cfg:*（settings、providers、mcp、skills、persona、install）
  diag.js            日志环 + diag:export
  ipc.js             safeHandle + 参数校验 + 日志
  config.js          （旧有）pi 配置文件的读写实现，供 config-ipc.js 使用

src/
  main.tsx           入口：StrictMode + ErrorBoundary
  App.tsx            Shell：侧边栏、顶栏、对话区、输入框、编排（双模型链）
  hooks/
    usePi.ts         RPC 事件 → React 状态（核心 reducer）
    useGit.ts        分支状态（cwd 变化 / 回合结束 / 窗口聚焦时刷新）
    useSessionStats.ts  上下文与费用统计
    useTheme.ts      浅色/深色主题（.dark class + localStorage）
    useDualModel.ts  双模型配置（localStorage）
    useTasks.ts      后台任务列表（term_add/term_data/term_exit 事件）
  components/
    chat.tsx         消息渲染（AI Elements + streamdown/mermaid）
    composer.tsx     输入框：发送/排队/steer、/ 与 @ 弹层、附件
    model-picker.tsx 锚定式模型选择器
    branch-picker.tsx 分支 chip + 切换弹层
    context-usage.tsx 上下文用量环 + 面板
    extension-dialog.tsx 扩展 select/input/editor 卡片（输入框上方）
    dual-model-dialog.tsx 双模型配置
    shortcuts-dialog.tsx / error-boundary.tsx
    terminal-panel.tsx / files-panel.tsx / agents-panel.tsx / browser-panel.tsx
    settings-dialog.tsx / command-palette.tsx / file-diff.tsx
    ui/  ai-elements/   shadcn/ui 与 Vercel AI Elements

docs/DEVELOPMENT.md  本文档
scripts/stage-runtime.mjs  打包前把 pi 的 bundle 复制到 runtime/
runtime/             pi 运行时（gitignore，由 stage 脚本生成）
```

---

## 3. 运行时与启动时序

### 3.1 运行时解析（`pi-process.js:resolveRuntime`）

1. `process.resourcesPath/runtime/cli.js` —— 打包内置；若存在 `runtime/bin/node` 用之，否则 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）
2. `$PI_CLI`（可用 `$PI_NODE` 指定解释器）
3. `~/.pi/agent/install/current-version` → `releases/<v>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`；node 依次取托管安装、PATH、Electron

版本：`runtimeVersion()` 读 `VERSION`（内置）或 `current-version`（托管），用于诊断与兼容提示。

### 3.2 启动 pi（`main.js:startPi`）

```
pi.stop() → 清理挂起对话框 → resolveRuntime()
→ supportsAppendPrompt(rt)   // spawn `pi --help` 探测，结果按 cli 路径缓存
   ├─ 支持：argv 追加 --append-system-prompt <PI_BG_INSTRUCTIONS>
   └─ 不支持：省略并发送 ui_notify 警告（pi-bg 本身仍可用）
→ PiProcess.start({ node, argv, cwd, env：
     PATH = <userData>/bin : dirname(node) : $PATH
     PI_DESKTOP_TERM_SOCK = <socket 路径>
     PI_MANAGED_INSTALL_ROOT（托管安装时） })
```

启动经 bootLock 串行化：快速连续切换项目时，后一次启动等前一次完成后执行（结果始终最新）。
`pi:start` 随后轮询 `get_state`（最多 40 × 400ms，直到出现 `model`），再取
`get_available_models` / `get_messages` 返回渲染层；渲染层再拉 `get_commands`、会话、项目。

### 3.3 PiProcess（`pi-process.js`）

- 一个子进程、`pending: Map<id, {resolve,reject}>` 做请求/响应关联
- stdout **按 LF 严格切分**（readline 会额外切 U+2028/U+2029，JSON 字符串里合法）
- `response` 记录先匹配 pending；`extension_ui_request` 交给 main 的 `handleExtensionUi`；其余原样转发渲染层
- **重启防错**：exit 回调先判断 `this.child === proc`，避免旧进程退出清空新引用（历史 bug）
- `stop()`：reject 所有 pending（`pi 重启中`）、关 stdin、1.5s 后 SIGKILL
- `command(payload, timeoutMs = 30s)`：单请求超时，pi 卡死不会永久挂起调用方

---

## 4. pi RPC 协议

### 4.1 用到的命令（渲染层 → `pi:send`）

| type | 参数 | 用途 |
|---|---|---|
| `get_state` | – | 模型/思考等级/流式/会话文件/名称/自动压缩 |
| `get_available_models` | – | 模型列表 |
| `get_messages` | – | 当前会话消息 |
| `get_entries` | – | 会话条目（带 id/parentId，用于 fork 与定位） |
| `get_commands` | – | 扩展/内置命令列表 |
| `get_session_stats` | – | tokens/费用/contextUsage |
| `prompt` | `message`, `images?`, `streamingBehavior?: "steer"｜"followUp"` | 发送；流式中按 behavior 排队/插入 |
| `abort` | – | 停止当前轮 |
| `compact` | – | 压缩上下文 |
| `clear_queue` | – | 清空排队消息 |
| `new_session` / `switch_session` | – / `sessionPath` | 新建/切换（流式中会先 abort） |
| `set_model` / `set_thinking_level` | `provider,modelId` / `level` | 切换模型/思考等级 |
| `set_session_name` | `name` | 重命名（追加 `session_info` 条目） |
| `fork` | `entryId` | 在**用户消息之前**分叉（RPC 限制） |
| `export_html` | `outputPath` | 导出会话 HTML |

### 4.2 转发到渲染层的事件（`pi:event`）

pi 的业务事件原样转发：`agent_start`、`turn_start/turn_end`、`message_start/message_update/message_end`、
`tool_execution_start/end`、`queue_update`、`agent_end`、`agent_settled`、
`compaction_start/end`、`session_info_changed` 等。

主进程额外合成：

| type | 载荷 | 说明 |
|---|---|---|
| `child_exit` | `{code, signal}` | pi 退出 |
| `client_error` | `{message}` | 无法解析的 JSONL 行 |
| `ui_notify` | `{message, notifyType}` | 扩展 notify / 兼容性提示；**渲染层目前未消费**，仅记录 |
| `ui_title` | `{title}` | 扩展 setTitle |
| `ui_status` | `{key,text}` | 扩展 setStatus（ANSI 已剥离；text 为空表示清除） |
| `ui_widget` | `{key,lines}` | 扩展 setWidget（已转发，UI 暂未渲染） |
| `ui_dialog` | `{dialog:{id,method,title,options?,placeholder?,prefill?}}` | select/input/editor 请求 |
| `ui_dialog_clear` | – | pi 重启/退出时关闭对话框 |
| `term_add` | `{task}` | 后台任务创建（静默任务也可见） |
| `term_data` | `{id, chunk}` | 任务输出 |
| `term_exit` | `{id, code, signal}` | 任务结束 |
| `cfg_progress` | `{line}` | `pi install/uninstall` 输出 |

### 4.3 会话文件格式（v3，`SUPPORTED_SESSION_VERSION = 3`）

位置：`~/.pi/agent/sessions/--<cwd 中 / 与 : 替换为 - >--/<ISO 时间戳>_<sessionId>.jsonl`

```
{"type":"session","version":3,"id":"<id>","timestamp":"...","cwd":"...","parentSession":"..."}
{"type":"model_change",...} / {"type":"thinking_level_change",...}
{"type":"message","id":"<entryId>","parentId":"...","message":{"role":"user|assistant|toolResult|system",...}}
{"type":"session_info","id":"...","parentId":"...","name":"重命名"}   // 最后一条生效
```

标题解析（`sessions.js:sessionTitle`）：先做廉价子串预过滤（只对含 `session_info` /
`"role":"user"` / `"toolCall"` 的行 `JSON.parse`），取最后一个 `session_info.name`，
否则第一条用户消息前 80 字符；同时统计 write/edit 的 +/- 行数。

版本守卫：文件级 fork 前校验 `header.version <= 3`，否则拒绝并提示升级。

---

## 5. IPC 参考（主进程 ↔ 渲染层）

所有 handler 经 `ipc.js:safeHandle` 注册：统一 try/catch、记录诊断日志；错误仍向渲染层
reject（调用方 `.catch` 语义不变）。启动期预期错误（`pi 未运行` / `pi 重启中`）不记日志。

渲染层 API 面见 `electron/preload.cjs`（`window.pi`）。

### 5.1 pi 与运行时

| channel | 参数 | 返回 |
|---|---|---|
| `pi:start` | `{cwd?}` | `{state, models, messages, cwd}` |
| `pi:send` | RPC payload | `data \| null` |
| `pi:pickFolder` | – | `path \| null` |
| `pi:reveal` | `path` | `shell.openPath` 结果 |
| `pi:uiRespond` | `{id, value?, cancelled?, confirmed?}` | `{ok,error?}`（非 pending 请求拒绝） |

### 5.2 会话

| channel | 参数 | 返回 |
|---|---|---|
| `pi:sessions` | – | `SessionInfo[]`（`path,id,cwd,timestamp,title,mtime,changed`） |
| `pi:deleteSession` | `{path}` | `{ok, switched?, error?}`；活跃会话先 `new_session` 再删文件 |
| `pi:forkSessionAt` | `{entryId}` | `{ok, sessionFile?, error?}`；写入新 JSONL 后 `switch_session` |
| `pi:exportHtml` | – | `{ok, path?, error?}`；系统保存框 + `export_html` |

### 5.3 项目 / git / 工作区

| channel | 参数 | 返回 |
|---|---|---|
| `projects:list` | – | `ProjectInfo[]`（`path,name,sessions,mtime,stored,exists`） |
| `projects:add` / `projects:remove` | `dir` | `{ok,error?}` |
| `git:status` | `{cwd}` | `{isRepo,branch,detached,ahead,behind,dirty,error?}` |
| `git:branches` | `{cwd}` | `{branches[],error?}`（按 committerdate 倒序） |
| `git:checkout` | `{cwd,branch}` | `{ok,error?}`（`switch` 失败回退 `checkout`） |
| `files:search` | `{cwd,query}` | `string[]`（≤40，深度/数量受限） |
| `files:tree` | `{cwd,dir?}` | `{name,path,dir}[]`（≤500） |
| `files:read` | `{cwd,file,abs?}` | `{content,size}` 或 `{error}`（限工作区、≤1MB） |
| `files:readTable` | `{cwd,file,abs?}` | xlsx/xls → `{ok,sheets:[{name,rows,truncatedRows}],truncatedSheets}`（SheetJS，`raw:false`；上限 30 sheet / 2000 行 / 80 列 / 20MB） |
| `files:readDoc` | `{cwd,file,abs?}` | docx → `{ok,html}`（mammoth 转 HTML，≤20MB；渲染层必过 DOMPurify） |
| `files:readPdf` | `{cwd,file,abs?}` | pdf → `{ok,data:Uint8Array}`（≤50MB；渲染层 page.js 画 canvas） |
| `files:extractText` | `{cwd,file,abs?}` | docx/pdf → `{ok,text}`（复用 `attachments:parse`，供预览面板「问 AI」内联） |
| `files:pickPreview` | – | 系统文件选择器（工作区外的下载/微信接收文件）→ `{ok,path,name}`；选中的绝对路径进本次运行的白名单 |
| `files:debugApprove` | `abs` | **仅 `PI_DEBUG=1`**：把绝对路径登记进白名单（等价于用户在选择器里选中，供 E2E 验正向路径） |
| `agents:list` | `{cwd?}` | `AgentProfile[]` |
| `ssh:hosts` | – | `string[]`（解析 `~/.ssh/config`） |

### 5.4 后台任务

| channel | 参数 | 返回 |
|---|---|---|
| `term:run` | `{cmd,cwd?,label?,host?}` | `{id,cwd}` |
| `term:list` | – | `TaskInfo[]` |
| `term:out` / `term:kill` / `term:remove` | `id` | 输出 / `{ok}` / `{ok}` |

### 5.5 配置与诊断

| channel | 说明 |
|---|---|
| `cfg:read` | 汇总 settings/providers/packages/skills/mcp/prompts/memory/persona |
| `cfg:setSetting` | 点号路径合并写入 `settings.json`，返回 `{ok,restart:true}` |
| `cfg:saveProvider` / `cfg:deleteProvider` / `cfg:setMcp` / `cfg:savePersona` / `cfg:setResources` | 配置修改（均返回 restart 标记） |
| `cfg:savePrompt` / `cfg:readPrompt` / `cfg:deletePrompt` | 自定义命令（prompts .md）读写删；落点守卫在两个 prompts 目录内，保存/删除返回 restart 标记 |
| `cfg:fetchModels` | 从供应商 `/models` 端点拉取模型列表（密钥留空回退已存密钥），并合并 models.dev 元数据（reasoning/模态/上下文/价格/推理档位，缓存 1h，目录不可达不影响主流程），返回 `{ok, models\|error}` |
| `cfg:gallery` / `cfg:readSkill` / `cfg:deleteSkill` | 包市场查询、技能读取/删除 |
| `cfg:install` / `cfg:uninstall` | shell out `pi install/remove`，输出经 `cfg_progress` 流式回传 |
| `diag:export` | 保存诊断 txt（版本/平台/运行时/会话/任务/日志），完成后可显示于 Finder |
| `pi:debugDialog` | **仅 `PI_DEBUG=1`**：注入一个假的扩展对话框用于调试 |
| `pi:debugWidget` | **仅 `PI_DEBUG=1`**：注入一条 widget 事件（与扩展 `setWidget` 同一条渲染通路） |
| `pi:debugQuit` | **仅 `PI_DEBUG=1`**：走真实 `app.quit()` 退出路径（验证"退出时钩子"类逻辑；硬杀不会给主进程跑钩子的机会） |
| `ui:getThinkingPrefs` / `ui:setThinkingPref` | 每模型思考档位记忆，存 `<userData>/ui.json` 的 `thinkingLevels`（键 `provider/modelId`）。**不要写进 pi 的 settings.json**，见 §7.9 |
| `attachments:parse` | 附件解析：pdf/docx 提取纯文本（unpdf/mammoth），zip 解压到临时目录并返回清单（防 zip-slip/超限）；渲染层将结果内联进 prompt |

---

## 6. 渲染层状态模型（`hooks/usePi.ts`）

单一 reducer，所有 pi 事件经 `window.pi.onEvent` 进入 `reduce(state, rec)`：

```ts
type State = {
  status: "connecting" | "ready" | "error" | "exited";
  error?: string;              // 任一 RPC 失败都会写入；成功请求自动清除
  cwd: string;
  model?: ModelInfo; models: ModelInfo[];
  thinkingLevel: string; isStreaming: boolean;
  messages: PiMessage[];       // get_messages / message_end 累积
  streaming: ContentBlock[] | null;  // message_update 的增量块
  tools: Record<string, ToolExec>;   // tool_execution_*（最多保留 400 条）
  queue: { steering: string[]; followUp: string[] };
  sessionName?: string; sessionFile?: string;
  sessions: SessionInfo[]; projects: ProjectInfo[];
  commands: CommandInfo[];
  statuses: Record<string, string>;  // 扩展 setStatus
  dialog: UiDialogRequest | null;    // 扩展 select/input/editor
  autoCompact: boolean;
};
```

要点：

- **事件订阅在每次挂载都重新注册**（`useEffect(() => window.pi.onEvent(...), [])`）；
  boot 由 `started` ref 护栏只跑一次 —— StrictMode 下曾因合并两个 effect 导致监听器被清理后不再注册
- 流式增量按 `contentIndex` 打块；`*_end` 事件携带权威内容；`message_end` 覆盖整条消息
- RPC 失败写入 `state.error` 并显示顶部横幅（可关闭）；任意成功请求清除
- `switch_session` / `new_session` 后**重新拉取 `get_state` + `get_messages`** 对齐会话身份，
  避免顶栏/高亮停留在旧会话（历史 bug）
- `openSession` 有请求序号守卫，快速连点只应用最后一次

---

## 7. 功能实现说明

### 7.1 会话列表与标题

`pi:sessions` 全量扫描 `~/.pi/agent/sessions`，解析结果按 (mtime,size) 缓存；超过 2MB 的会话只读头尾各 1MB/512KB（标题在头、重命名在尾），跨界的行 JSON.parse 失败自动跳过。
侧边栏三种视图：按时间分组（今天/昨天/本周/更早）、按项目分组（工作区，空项目显示「暂无任务」）、
时间线。跨项目会话带项目徽标；点击使用 `switch_session`（pi 会用会话头里的 cwd 重建运行时）。

行内菜单：重命名（活跃会话直接 `set_session_name`，否则先切换）、打开、导出 HTML（仅活跃）、
Finder 显示、复制会话 ID、删除（二次确认变红）。删除活跃会话时主进程先 `new_session` 再删文件。

### 7.2 Fork

| 消息类型 | 实现 | 语义 |
|---|---|---|
| 用户消息 | RPC `fork(entryId)` | 新会话 = 该提问**之前**的历史；返回该提问文本，输入框预填 |
| 助手/任意条目 | `pi:forkSessionAt` | 主进程按 `parentId` 链回溯，写新 JSONL（新 header `parentSession` 指向原会话）后 `switch_session` |

消息对象没有 entryId，`forkAt` 用 `get_entries` 以 `role + timestamp` 反查。

### 7.3 输入框

- 发送：Enter；Shift+Enter 换行；流式中 Enter 排队（`followUp`），Option+Enter 立即插入（`steer`）。
  发送**总是带 `streamingBehavior`** —— 空闲时被 pi 忽略，流式中缺失会被拒绝（历史 bug 的根因之一）
- `/` 命令、`@` 文件引用弹层（组标题、目录灰显、失焦关闭）
- 附件：粘贴/拖拽/`+` 按钮；图片转 base64 随 prompt 发送
- 输入框上方：分支 chip、扩展状态 chip、双模型阶段 chip
- 输入框下方：用量环、双模型按钮、模型选择器（锚定弹层，非模态）、思考等级、计划模式、附件、停止/排队/发送

### 7.4 上下文用量

`get_session_stats` → 环（<70% 主色 / ≥70% 琥珀 / ≥90% 红）+ 面板：
contextUsage（tokens/窗口/百分比）、提问/回复数、工具调用、消息数、输入/输出/缓存读/缓存写/总计、
缓存命中率、费用。缓存命中率 = `cacheRead / (input + cacheRead)`；当 `cacheRead` 与 `cacheWrite`
都为 0 时显示 `—` 并注明「服务商未上报缓存用量」（不是 0% 命中）。

刷新时机：打开面板、切换会话、每轮结束。

### 7.5 Git

`git status --porcelain=v2 --branch` 一次取得分支/ahead/behind/脏状态；分支列表
`for-each-ref --sort=-committerdate`。切换优先 `git switch`，失败回退 `git checkout`。
刷新时机：cwd 变化、每轮 agent 结束（agent 可能执行了 git）、窗口重新聚焦、切换之后。

### 7.6 扩展协议

| 方法 | 处理 |
|---|---|
| `confirm` | Electron 原生对话框（取消/确认） |
| `notify` / `setTitle` | 转发为 `ui_notify` / `ui_title` |
| `setStatus` / `setWidget` | 转发（ANSI 剥离）；status 渲染为 chip |
| `select` / `input` / `editor` | 输入框上方卡片；响应经 `pi:uiRespond` 写回；Esc/取消/关闭均回 `cancelled`，pi 不会挂起 |

请求跟踪：`pendingDialogs: Set<id>`；pi 重启/退出时清空并发送 `ui_dialog_clear`。
`rpiv-ask-user-question` 在 RPC 模式正是依赖 `select/input` 才能工作。

### 7.7 后台任务桥（pi-bg）

pi 的 bash 工具没有后台模式。桌面端：

1. 安装 CLI 到 `<userData>/bin/pi-bg`（Windows 另有 `pi-bg.js` + `pi-bg.cmd`，经 Electron 自身 Node 运行）
2. 启动一个本地桥：Unix socket `<userData>/term.sock`（0600）或命名管道 `\\.\pipe\pi-desktop-term-<user>`
3. 通过 PATH / `PI_DESKTOP_TERM_SOCK` 注入给 pi 及其子进程；`--append-system-prompt` 告知 agent 长任务用 pi-bg
4. 任务与终端面板共用同一张表（`origin: agent|user`），模板渲染带 agent 徽标

```
pi-bg "<command>" [--cwd DIR] [--label TEXT] [--host HOST]
pi-bg --list | --output ID | --kill ID | --wait ID [--timeout 秒]
```

桥协议：一行 JSON 请求 / 一行 JSON 响应，支持 `run/list/output/kill/wait`。

### 7.8 双模型（自动链式）

配置（`localStorage: pi-desktop-dual-model`）：`{enabled, planner, executor}`。

```
submit（enabled && idle && 未流式）
  → 记录原模型与原 sessionFile
  → switchModel(planner)（只改实时会话，不写默认设置）
  → prompt(【规划阶段】… , files, followUp)
一轮 settle（agent_settled 之后 isStreaming=false）
  → 若 sessionFile 变了：链条中止（不恢复模型）
  → switchModel(executor) → prompt(【执行阶段】…, followUp)
规划轮 settle 后：把规划回复写入 <cwd>/.pi/plans/plan-<时间戳>.md（$plans:save），
执行指令携带该文件路径；执行轮 settle → resetDualChain() → 恢复原模型
```

护栏：`started` 标志避免「尚未开始就判定结束」；停止按钮先中止链条再 `abort`；
配置缺模型时回退普通发送，不吞消息。

### 7.9 模型与思考等级持久化

**模型**：选择模型时写 pi 全局设置（`defaultProvider` / `defaultModel`）。pi 新建会话
时读取这些键，因此应用重启后保持选择。内部切换（双模型、会话切换）**不写**默认值。

**思考等级（每模型记忆）**：**不能旁路写 pi 的 `settings.json`**——pi 把整份设置握在
进程内存里，任何我们写入的键都会被 pi 下一次 `save()`（如切模型）整文件覆盖；RPC
`set_thinking_level` 也没有 `persist` 选项（`options.persist` 只给 CLI TUI 用）。
所以桌面端自己记账：

1. `setThinking` 把 `provider/modelId → level` 写进 `<userData>/ui.json`（`ui:setThinkingPref`），pi 永不碰这个文件
2. `applyThinkingPref`（`usePi.ts`）在 **boot / 打开会话 / fork 之后 / 新建会话 / 切模型** 时读记忆，与当前档位不同就 `set_thinking_level` 注入
3. 只记用户**显式选择**过的档位：没动过的模型继续跟随 pi 的全局默认，避免把继承值冻结成 per-model 键

pi 内部档位解析顺序：会话内 > `settings.modelThinkingLevels[provider/model]` > 全局
`defaultThinkingLevel`；模型没声明 `reasoning` 时可用档位只有 `off`（设置会被钳位）。

### 7.10 文件预览（xlsx / docx / pdf）

右侧文件面板 = 预览器入口（`files-panel.tsx`），按扩展名路由：

| 类型 | 主进程 | 渲染层 |
|---|---|---|
| xlsx / xls | `files:readTable`（SheetJS，`raw:false` 取显示值） | **AG Grid Community**：虚拟滚动、列宽/排序、quick filter；多 sheet 标签 |
| csv / tsv | `files:read`（文本） | 同一套 `TableGrid`（`DelimitedTable` 切分后复用） |
| docx | `files:readDoc`（mammoth → HTML） | `.doc-preview` 排版样式 + **DOMPurify 净化后** `dangerouslySetInnerHTML` |
| pdf | `files:readPdf`（字节） | **pdfjs-dist** 渲染 canvas、翻页、适宽（worker 经 Vite `?url` 走 `file://`） |

**外部文件**：工作区外的文件（下载目录、微信接收）走文件面板的「打开文件」按钮——
`files:pickPreview` 弹系统选择器，选中的绝对路径登记进**仅本次运行有效**的白名单；
`read*` / `extractText` 用 `abs` 参数读它。未登记路径一律拒（`resolveReadTarget`）。

两个闭环：

- **问 AI**：预览头部按钮把当前文件带进输入框——xlsx 预填 `table` 工具指令（模型读得懂公式和多 sheet）；docx/pdf 走 `files:extractText` 内联正文（pi 的 `read` 读不懂二进制），上限 15k 字
- **自动刷新**：`App` 在 `isStreaming` 由 true→false 时 `previewTick+1`，预览面板据此重读当前文件（AI 用 `table` 工具重写文件后立刻可见）

**`table` 扩展**（`electron/table-extension.js`，随应用分发到 `<agent>/extensions/table.ts`）：

- `write`：`sheets:[{name, rows:[[值 | {v,f:"=SUM(B2:B5)"}]]}]` → 真 xlsx，公式写进 `cell.f`（SheetJS 不认前导 `=`），由 Excel 打开时计算
- `read`：逐 sheet 输出制表符文本，公式显示为 `=表达式`（读时需要 `cellFormula + sheetStubs` 才看得到"只有公式、无缓存值"的格子）

⚠️ **扩展依赖解析以扩展文件为基准**（pi 只把 `typebox` / `@earendil-works/*` 别名进
runtime）。所以 SheetJS 必须落到 `<agent>/extensions/node_modules/xlsx`：
`installTableExtension(agentDir, xlsxSource)` 按版本号幂等复制（源码目录在打包后位于
asar 内，复制走 `readFile/writeFile` 而不是 `cpSync`）。新的自研扩展如果还要引别的
npm 包，照这个模式办，**不要指望 stage 脚本 vendor**（那是给 pi bundle 自己的外部依赖用的）。

### 7.11 应用内更新

`electron-updater` + GitHub Releases（`build.publish`）。状态机：
`idle → checking → up-to-date | available → downloading → ready`（error 随时可能进入）。
状态由主进程 `update_status` 事件推送；侧边栏底部按钮随状态变化
（检查 → 下载 → 百分比 → 重启对话框；错误时点击打开发布页）。
启动 8 秒后自动静默检查一次；`--version` 语义比较避免同版本误报。
未打包（dev）时返回 `dev` 状态，UI 仅显示当前版本。

### 7.12 主题 / 快捷键 / 导出 / 诊断

- 主题：`useTheme` 切 `<html>.dark`，`localStorage: pi-desktop-theme`
- 快捷键：⌘K 面板、⌘N 新建任务；完整列表在「快捷键」对话框
- 导出 HTML：会话行菜单（仅活跃会话）
- 诊断：日志环 500 条（pi stderr / IPC 异常 / 未捕获异常 / 启动信息）+ 版本、运行时、会话、任务快照 → 保存 txt

---

## 8. 持久化与文件位置

| 数据 | 位置 | 写入方 |
|---|---|---|
| pi 设置（模型默认值等） | `~/.pi/agent/settings.json` | `config-ipc.js` |
| 会话 | `~/.pi/agent/sessions/--cwd--/*.jsonl` | pi 本体（fork 由主进程写新文件） |
| 项目列表 | `<userData>/projects.json` | `projects.js` |
| 主题 | `localStorage: pi-desktop-theme` | 渲染层 |
| 双模型配置 | `localStorage: pi-desktop-dual-model` | 渲染层 |
| pi-bg CLI | `<userData>/bin/pi-bg`（+ `.js`/`.cmd`） | 主进程启动时幂等写入 |
| 任务桥 | `<userData>/term.sock` 或命名管道 | 主进程 |
| 运行时版本 | `runtime/VERSION` / `~/.pi/agent/install/current-version` | 构建/pi |

`<userData>`：macOS `~/Library/Application Support/pi-desktop`，Windows `%APPDATA%/pi-desktop`，
Linux `~/.config/pi-desktop`。

---

## 9. 跨平台

| 方面 | macOS / Linux | Windows |
|---|---|---|
| 任务桥 | Unix socket（0600） | 命名管道 `\\.\pipe\pi-desktop-term-<user>` |
| 任务 shell | `$SHELL -lc`（无 zsh 回退 `/bin/sh`） | `cmd.exe /d /s /c` |
| 停止任务 | `SIGTERM` | `taskkill /pid … /T /F`（杀进程树） |
| pi-bg | 带 shebang 的可执行脚本 | `pi-bg.cmd` → Electron-as-Node 运行 `pi-bg.js` |
| 查找 node | `X_OK` | 按 `PATHEXT` 枚举 |
| 路径 | `path.delimiter`；UI 用 `baseName()` 兼容两种分隔符 | 同左 |

Windows 代码路径按 Node/Electron 文档实现，**未在 Windows 真机验证**（上线前需验证）。

---

## 10. 开发与调试

```bash
npm install
npm start                 # 构建 + Electron（生产资源）
npm run dev               # 只跑 Vite
PI_DEV_URL=http://localhost:5173 npm run electron   # 热更新模式
npm run dist              # 打包（electron-builder，dir 目标）
npm run stage             # 把本机 pi bundle 复制进 runtime/
```

环境变量：

| 变量 | 作用 |
|---|---|
| `PI_DEV_URL` | 渲染层加载 Vite dev server（热更新） |
| `PI_CLI` / `PI_NODE` | 覆盖 pi CLI / 解释器 |
| `PI_DEBUG` | 打开 `pi:debugDialog` / `pi:debugWidget` / `pi:debugQuit`、boot 轮询日志 |
| `PI_DESKTOP_HOME` | 覆盖 APP_HOME（默认 `~/.pi-desktop`）：projects.json、bin/、ui.json 都在这一层。**E2E 必须设**，否则测试会把 fixture 目录写进用户真实 projects.json |
| `PI_AGENT_DIR` | 覆盖 agent 目录（默认 `<APP_HOME>/agent`） |
| `PI_DESKTOP_TERM_SOCK` | 由主进程注入给子进程，指向任务桥 |

调试技巧：

- `--remote-debugging-port=9222` 启动后可用 CDP 读取 `window.__pi`（渲染层状态快照，
  每次渲染时挂到 window）并模拟输入/点击
- 扩展对话框可用 `PI_DEBUG=1` + `window.pi.debugDialog({method, title, options})` 直接预览
- 退出流程（pool.stopAll → 子进程 onExit → app.quit）用 `PI_DEBUG=1` + `window.pi.debugQuit()`
  验证；硬杀主进程不会给退出钩子留机会，别拿它验退出逻辑
- 任务桥可直接用 CLI 验证：`PI_DESKTOP_TERM_SOCK=… pi-bg --list`
- 自研扩展加载失败先直接跑 CLI（`PI_CODING_AGENT_DIR=<agent> runtime/bin/node runtime/cli.js --mode rpc`
  喂一行 `{"id":1,"type":"get_state"}`），stderr 会给出 `Cannot find module '…'` 的真实原因

测试：`npm test`（`node --test tests/`）覆盖会话标题/扫描排序/fork 构建/版本守卫、任务桥（真实 spawn + socket），
以及 todo / table 扩展（jiti 加载真实 TS 源码 + SheetJS 回读断言公式）。CI 见 `.github/workflows/ci.yml`
（stage（扩展测试要 runtime/node_modules）→ tsc --noEmit → build → test；e2e 用 xvfb + `ELECTRON_DISABLE_SANDBOX`）。

常见冒烟清单：

1. 启动后 `status=ready`、模型、命令数、会话/项目列表
2. 发消息 → 流式渲染 → 回复落库
3. 新建/切换/删除会话，标题与高亮正确
4. 跨项目切换（pi 用会话 cwd 重建）
5. fork 用户消息（预填）与助手消息（含该回复）
6. `pi-bg` 创建/列表/停止，面板出现 agent 任务
7. 扩展 `ask_user_question` 弹卡片、选择后 agent 继续
8. 主题切换、⌘N、⌘K、导出 HTML/诊断
9. 文件面板点开 xlsx（AG Grid 网格 + 多 sheet）、docx（正文）、pdf（canvas 页）
10. 预览「问 AI」把文件带进输入框；AI 改写文件后回合结束预览自动重读

---

## 11. 已知风险与限制

| 级别 | 问题 | 说明 / 方向 |
|---|---|---|
| 高 | 与 pi 内部格式耦合 | 手写会话 JSONL、标题解析、CLI flag 探测。已加会话版本守卫与 flag 探测降级；建议再加启动契约冒烟并锁定经测试的 pi 版本 |
| ~~高~~ 已修 | ~~会话扫描 O(总字节)~~ | (mtime,size) 缓存 + >2MB 头尾读取 |
| ~~中~~ 已修 | ~~command 无超时、boot 无互斥~~ | 单请求 30s 超时；boot 经 bootLock 串行化 |
| ~~中~~ 已收口 | ~~安全面~~ | openExternal 仅 http(s)；webview 禁 window.open/独立校验 src；readSkill 限定技能目录 + 1MB 上限 |
| ~~中~~ 部分完成 | ~~渲染层单体~~ | App.tsx ~370 行（Sidebar/双模型链已抽出）；settings-dialog 拆分仍待做 |
| ~~中~~ 已建 | ~~测试/CI 缺失~~ | 8 个 node:test 冒烟全绿；CI（tsc/build/test）已配置；存量 tsc 错误清零 |
| 低 | 偏好存储分散 | localStorage / projects.json / ui.json / pi settings 四处；建议统一 app prefs |
| 低 | 打包分发 | 三平台 dmg/zip/nsis/AppImage + GitHub Releases 发布已配置（push v* tag）；自动更新已实现；macOS 未签名（自动更新受限）、无公证；Windows 未签名（SmartScreen 提示，README 有说明） |
| ~~低~~ 已改 | ~~Windows 未真机验证~~ | Windows 已是日常主力平台（任务栏图标、命名管道、pi-bg.cmd 均实测） |
| 低 | 扩展 `ui_widget` / `ui_notify` | 已转发并渲染（widget 卡片串 + 通知） |
| 中 | 扩展依赖解析以扩展文件为基准 | 自研扩展引第三方包必须装到 `<agent>/extensions/node_modules`（见 §7.10）；stage 脚本的 vendor 只管 pi bundle 自身 |
| 低 | xlsx 依赖随扩展复制 | 每个版本号首次启动往 `<agent>/extensions/node_modules` 拷 7MB SheetJS；换版本会重拷一次（幂等，可接受） |
| 低 | 预览只覆盖 xlsx/docx/pdf/csv | 图片走原图、其余按文本/代码；docx 的复杂版式（分栏/页眉页脚）mammoth 会丢 |

---

## 12. 变更记录

### v0.2.30 – v0.2.34 — 预览体系、表格工具、思考档位记忆、首启引导

- **思考档位**：改为桌面端自持（`ui.json` 记忆 + boot/切会话/切模型注入），pi 的
  `settings.json` 视作 pi 私有（见 §7.9）；`PiProcess.exit` 修复了"主动停止的进程不触发
  onExit"（重启竞态护栏误伤，槽清理/退出钩子都挂在它上面）；`before-quit` 等子进程死透再退
- **文件预览**：`files:readTable/readDoc/readPdf/extractText` + AG Grid / mammoth /
  pdfjs-dist / DOMPurify（见 §7.10）；预览「问 AI」与回合结束自动重读
- **table 扩展**：模型可读写带公式的 xlsx；依赖复制到 `<agent>/extensions/node_modules`
- **todo 扩展**：`turn_end` 仍有未完成项时自动注入提醒（同批防循环）
- **侧栏**：去掉顶部搜索输入框；"新建会话"下沉到项目行悬停 ＋；driver.js 首启引导
  （`pi:tour` 事件可从 设置→版本 重放）
- **CI**：check 任务补 `npm run stage`；e2e 在 CI 关 sandbox 并倒 stderr；E2E 隔离
  `PI_DESKTOP_HOME`；`PI_DEBUG` 新增 `pi:debugQuit`
- **Windows**：显式窗口图标（`pi.ico` extraResources）+ dev/prod AUMID 拆分（任务栏不再
  回落 Electron 默认图标）

### 2181e09 — Split main process, add diagnostics/dialogs safeguards, dual-model mode

- 主进程拆分为 9 个模块；新增 `ipc.js:safeHandle`（参数校验 + 日志环）
- `--append-system-prompt` 能力探测与降级；会话格式版本守卫
- 诊断日志环 + ⌘K「导出诊断信息」
- ErrorBoundary、主题切换、快捷键对话框 + ⌘N、会话导出 HTML
- 双模型自动链式（规划 → 执行 → 恢复原模型）

### 1d639d8 — Support extension select/input/editor dialogs

- select/input/editor 转发渲染层并以卡片应答；`pi:uiRespond` 回写
- pi 重启/退出清理待应答请求；输入框上方锚定展示；Esc 恒回 `cancelled`

### dc35031 — Pi Desktop: ZCode-parity UI, session fork, git and background tasks

- 会话：新建/切换状态同步、标题解析修复、删除、跨项目统一列表、项目持久化
- 输入框：模型/思考等级内嵌、Enter 发送、排队/steer、停止、附件、/ 与 @ 弹层
- 上下文用量环与面板；fork（用户消息原生 / 任意条目文件级）
- git 分支 chip 与切换；扩展 setStatus 透传（ANSI 剥离）
- 后台任务桥（pi-bg + socket/命名管道）；agent 任务标记；实时时长/停止
- 修复：StrictMode 事件监听器丢失、mermaid 未导入导致整树崩溃、重启竞态清空 live child
- 跨平台：Windows 命名管道/cmd/taskkill/PATHEXT/pi-bg.cmd

### f9d3009 — Pi Desktop: Electron + React client for pi（初始）

---

## 13. 后续路线（建议顺序）

1. 稳定性：`command` 超时、boot 单飞、会话扫描缓存、启动契约冒烟
2. 安全收口：`openExternal` scheme 白名单、webview 隔离、技能路径校验
3. 渲染层拆分：编排 hooks + 设置页按 tab 拆分
4. 工程化：CI、冒烟测试、清理存量 tsc 错误
5. 分发：签名/公证、自动更新、Windows 真机验证

---

## 14. 排错索引

| 症状 | 排查 |
|---|---|
| 界面无反应 / 消息不更新 | 是否为热更新模式？StrictMode 监听器问题已修复；检查 `window.__pi.status` |
| 「pi 未运行」/「pi 重启中」 | 正常出现在启动/重启瞬间；持久出现则看诊断日志里 `[pi]` 启动行 |
| 发送被拒「already processing」 | 已通过恒定 `streamingBehavior` 规避；若复现检查 `isStreaming` 与 pi 状态 |
| 扩展提问不弹窗 | `PI_DEBUG` 下用 `debugDialog` 验证渲染层；再查 `pendingDialogs` 与 `ui_dialog` 事件 |
| pi-bg 不可用 | 检查 `<userData>/bin/pi-bg`、socket 路径、`PI_DESKTOP_TERM_SOCK` 环境变量；`pi-bg --list` 直接验证 |
| 分支不更新 | `useGit` 刷新时机：cwd 变化/回合结束/聚焦；可手动切分支触发 |
| 模型重启后重置 | 检查 `~/.pi/agent/settings.json` 的 `defaultProvider/defaultModel` 是否写入 |
