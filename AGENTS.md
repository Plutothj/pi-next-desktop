# AGENTS.md

pi coding agent 的桌面客户端：Electron 主进程 + React 渲染层 + `pi --mode rpc` 子进程（stdio JSONL）。外壳不实现 agent 循环，pi 是唯一事实来源，外壳只做编排、缓存与 UI。

**改协议、会话格式、IPC、pi-bg 桥之前先读 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**（完整的模块图、RPC 命令表、IPC 通道表、排错索引）。

## 常用命令

```bash
npm start        # vite build + 启动 Electron（生产资源）
npm run dev      # 只跑 Vite dev server
PI_DEV_URL=http://localhost:5173 npm run electron   # 热更新开发模式（日常开发用这个）
npm run stage    # 把 ~/.pi/agent/install 下的 pi bundle 复制进 runtime/（gitignore，生成物，勿手改）
npm run dist     # stage + build + electron-builder（仅 dir 目标）
npx tsc --noEmit # 类型检查（当前 0 错误，务必保持）
```

测试 `npm test`（node --test tests/）；CI `.github/workflows/ci.yml`（tsc --noEmit + build + test）。Electron 下载失败（网络原因）用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。

## 发版

```bash
npm version patch -m "Bump version to %s"   # 一条命令：改 package.json + package-lock.json、自动提交、打 tag
git push --follow-tags                       # 推提交和 tag；release.yml 只认 v* tag，自动多平台打包
```

- **不要手改 package.json 版本号**——lockfile 不会跟着同步（历史上 package-lock.json 的 version 曾因此停留在旧版本）。
- bump 提交由 `npm version` 自动生成且独立；它默认拒绝脏工作区，所以先提交完代码改动再发版，天然不会混提交。
- 日常功能更新用 patch（现状惯例），破坏性改动用 minor。

## 目录与分层

- `electron/` 主进程，**纯 JS ESM**（`preload.cjs` 除外）。按职责拆模块：`main.js`（窗口/生命周期/扩展 UI 桥）、`pi-process.js`（运行时解析 + RPC 子进程）、`sessions.js`（扫描/标题/fork/导出）、`git.js`、`tasks.js`（后台任务桥 + pi-bg）、`workspace.js`、`projects.js`、`config-ipc.js` + `config.js`、`diag.js`、`ipc.js`。新功能进对应模块，不要往 `main.js` 里堆。
- `src/` 渲染层 React 19 + TypeScript + Tailwind v4，路径别名 `@/* → src/*`。
  - `hooks/usePi.ts`：所有 pi 事件进单一 reducer，是渲染层状态核心
  - `components/ui/` shadcn/ui、`components/ai-elements/` Vercel AI Elements，优先复用
- `runtime/`：pi 的 bundle（stage 脚本生成），`dist/`、`release/` 同为生成物。

## 硬性规则

- **IPC**：所有 `ipcMain.handle` 必须经 `ipc.js` 的 `safeHandle` 注册，参数用 `requireString` / `requireObject` 等校验；启动期预期错误（消息含 `pi 未运行` / `pi 重启中`）不记日志。
- **渲染层唯一 API 面是 `window.pi`**（preload contextBridge）；新增主进程能力 = 新 channel + preload 方法，渲染层不直接碰 Node。
- **RPC stdout 按 LF 严格切分**（不要换回 readline——它会额外切 U+2028/U+2029，JSON 字符串里合法）。
- **prompt 总是带 `streamingBehavior`**：空闲时 pi 忽略，流式中缺失会被拒。
- 会话 JSONL 是 pi 的内部格式（当前 v3，`SUPPORTED_SESSION_VERSION`）：手写/复制文件前必须过版本守卫；标题解析已有廉价预过滤，别逐行 `JSON.parse` 全量。
- `PiProcess` 的 exit 回调：被新进程顶替的旧进程不算新闻，但 `stop()` 主动停的**必须**照常触发 `onExit`（`this.stopped` 标记）——槽清理与退出钩子都挂在上面，历史 bug。
- **新建会话必须走 `pi:createSession`（新开池槽），不要用 pi 的 `new_session`**：后者是替换当前进程里的会话，会 teardown 正在跑的回合——"同项目开第二个会话就把第一个打断"的根因。后台会话的完整事件不转发，只发 `session_status` 驱动运行指示。项目里的「+」/打开项目也要走它；`pi:start` 的新会话必须用**唯一临时键**，绝不能拿 `null` 当池键（两次 boot 会命中同一个槽，把正在跑的会话当成新会话复用）。
- **阻塞型扩展对话框按会话归属记账**（`pendingDialogs: id → {sessionFile, request, dialog}`）：切会话/开新会话时用 `pool.stashDialog` 暂存回对应槽、切回时重放，回答也发给对话框所属会话。直接丢弃会让 pi 永远等一个没人回答的响应，正在跑的回合卡死在半路——表现为"在别的项目新建对话把这边打断了"。
- 渲染层事件订阅 effect 每次挂载都要重新注册，boot 用 `started` ref 护栏只跑一次（StrictMode 双挂载，历史 bug）。
- 注释与用户可见文案用中文，标识符用英文，与现有代码一致。
- **危险操作（删除/卸载/还原）的确认框必须用 `useConfirm()`（`src/components/ui/confirm-dialog.tsx`），不要用 `window.confirm`**：原生弹框和暗色 UI 割裂，阻塞渲染；CDP 驱动的 E2E 遇到原生 confirm 会直接挂住。
- UI 交互默认对齐 ZCode Desktop 的行为（Enter 发送、流式排队/steer、弹层从输入框上方出、模型选择器内嵌输入框）。

## 跨平台

Windows 与实际 macOS 均已真机日常使用（命名管道、`cmd /d /s /c`、`taskkill /T`、`pi-bg.cmd`、PATHEXT、任务栏图标/AUMID 均已实测）。路径拼接用 `path.delimiter` / 双分隔符。

## 环境变量

`PI_DEV_URL`（热更新）、`PI_CLI` / `PI_NODE`（覆盖 pi CLI/解释器）、`PI_DEBUG`（调试对话框/widget/优雅退出 + boot 日志）、`PI_DESKTOP_HOME` / `PI_AGENT_DIR`（数据目录覆盖，E2E 必须设）、`PI_DESKTOP_TERM_SOCK`（主进程注入给 pi 的任务桥地址）。

## 已知风险（改相关区域时注意）

- 会话扫描每次全量读 `<AGENT_DIR>/sessions`，O(总字节)，别再加重扫描逻辑。
- **pi 的 `settings.json` 是 pi 进程私有**：旁路写会被它下一次 save 整文件覆盖（思考档位因此走 ui.json + 注入，见 DEVELOPMENT §7.9）。
- **计划模式不要再用 prompt 前缀**：走 `plan-mode.ts` 扩展（Enter/ExitPlanMode 工具 + `tool_call` 闸门 + `before_agent_start` 系统提示注入 + 审批卡片），状态是与会话文件同级的 `.plan-mode.json`。注意系统提示 section 名必须匹配 `^[a-z][a-z0-9_-]*$`（写成 `"Plan mode"` 会让 pi 拒绝整个请求，见 DEVELOPMENT §7.11.1）。
- **远程访问是内置模块**：`electron/remote-extension.js` 把应用自带的 `pi-mobile` 及整棵依赖复制到 `<agent>/extensions/pi-mobile` + `extensions/node_modules`；不要再把 `pi-mobile` 加进「推荐扩展」。`/remote` 是 pi 扩展命令，必须以 prompt 文本发送（pi 会先执行命令、不入模型回合），并且手机只走 HTTPS（Tailscale/自建反代），hub 只监听回环。
- **自研扩展的依赖解析以扩展文件为基准**（只有 typebox/@earendil-works 被别名进 runtime）：引第三方包要装到 `<agent>/extensions/node_modules`（table 扩展的 SheetJS 就是这么做的）。
- **技能有两个用户级根**：`<AGENT_DIR>/skills` 与 `~/.agents/skills`（`config.USER_SKILL_ROOTS`）。删除/读取的路径守卫必须覆盖两者，否则共享技能会"点了删除没反应"。
- **侧栏项目分组由会话的 cwd 推出来**：`projects:remove` 只改 projects.json 不会让有会话的项目消失。渲染层要用 `projects.state().removed` 把整组会话一起过滤掉（会话文件仍在磁盘上，重新添加文件夹即恢复）。
- `App.tsx`（~900 行）与 `settings-dialog.tsx`（~1700 行）偏大，改时优先局部修改，拆分是既定方向但尚未做。
