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
- `PiProcess` 的 exit 回调先判 `this.child === proc` 再清理（重启竞态，历史 bug）。
- 渲染层事件订阅 effect 每次挂载都要重新注册，boot 用 `started` ref 护栏只跑一次（StrictMode 双挂载，历史 bug）。
- 注释与用户可见文案用中文，标识符用英文，与现有代码一致。
- UI 交互默认对齐 ZCode Desktop 的行为（Enter 发送、流式排队/steer、弹层从输入框上方出、模型选择器内嵌输入框）。

## 跨平台

macOS 为主力开发平台。Windows 代码路径（命名管道、`cmd /d /s /c`、`taskkill /T`、`pi-bg.cmd`、PATHEXT）已实现但**未真机验证**，改动时按 Node/Electron 文档推断，不要假定已验证。路径拼接用 `path.delimiter` / 双分隔符。

## 环境变量

`PI_DEV_URL`（热更新）、`PI_CLI` / `PI_NODE`（覆盖 pi CLI/解释器）、`PI_DEBUG`（调试对话框 + boot 日志）、`PI_DESKTOP_TERM_SOCK`（主进程注入给 pi 的任务桥地址）。

## 已知风险（改相关区域时注意）

- 会话扫描每次全量读 `~/.pi/agent/sessions`，O(总字节)，别再加重扫描逻辑。
- `PiProcess.command` 无超时、boot 无互斥。
- `App.tsx`（~900 行）与 `settings-dialog.tsx`（~1700 行）偏大，改时优先局部修改，拆分是既定方向但尚未做。
