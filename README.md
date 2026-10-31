# Pi Desktop

pi coding agent 的桌面客户端。Electron 壳 + React/shadcn/ui 界面，后端直接跑 `pi --mode rpc`。

## 运行

```bash
npm install
npm start          # 构建前端并启动 Electron
npm run dev        # 只跑 Vite 开发服务器（配合 PI_DEV_URL 使用）
```

Electron 二进制下载失败时（GitHub 被墙）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

## 结构

```
electron/main.js      主进程：spawn pi RPC 子进程、JSONL 解析、IPC 桥、会话列表
electron/preload.cjs  contextBridge → window.pi
src/App.tsx           侧边栏（历史会话）+ 顶栏（模型/思考等级）+ 对话区
src/hooks/usePi.ts    RPC 事件 → React 状态（流式增量、工具调用、队列）
src/components/chat.tsx  消息渲染，基于 AI Elements
src/components/ui/    shadcn/ui 组件
src/components/ai-elements/   Vercel AI Elements（conversation / message / prompt-input / tool / reasoning / model-selector）
```

## 运行时解析顺序

1. `process.resourcesPath/runtime/cli.js`（打包后的内置运行时，含 `bin/node`）
2. `$PI_CLI`
3. `~/.pi/agent/install/` 下由 `current-version` 指向的版本；node 依次取 `~/.local/share/pi-node/current/bin/node`（若存在）、PATH 里的 `node`、最后 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`

## 后台任务桥接

pi 的 bash 工具没有后台模式，所以桌面端安装了 `pi-bg`（`userData/bin`，通过 PATH 注入给 pi 及其子进程），命令经本地 Unix socket（`userData/term.sock`，0600）进入终端面板的任务表：

```bash
pi-bg "<command>" [--cwd DIR] [--label TEXT] [--host HOST]
pi-bg --list | --output ID | --kill ID | --wait ID [--timeout 秒]
```

桌面端启动 pi 时通过 `--append-system-prompt` 告知 agent：长命令（dev server、watch、长构建）用 `pi-bg` 启动。任务与面板里手动启动的任务共用一套状态，面板中带 `agent` 标记。

跨平台：macOS/Linux 用 Unix socket（0600）与 `$SHELL -lc`；Windows 用命名管道 `\\.\pipe\pi-desktop-term-<user>`、`cmd.exe /d /s /c` 执行任务、`taskkill /T` 停止进程树，并额外安装 `pi-bg.cmd`（经 Electron 自带的 Node 运行，不依赖系统 Node）。PATH 拼接与路径解析均使用 `path.delimiter` / 双分隔符处理。

## 已知限制

- 会话历史没有 RPC 命令，直接扫 `~/.pi/agent/sessions/*/*.jsonl` 读首行和第一条用户消息。
- 扩展的 `select` / `input` / `editor` 对话框未实现，一律回 `cancelled`，避免 pi 卡死（`confirm` / `notify` / `setTitle` / `setStatus` / `setWidget` 已支持）。
- fork 助手消息/任意条目由主进程按 parentId 链复制会话文件实现（pi RPC 只支持在用户消息前 fork）。
