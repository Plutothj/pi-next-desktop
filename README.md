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

## 已知限制

- 会话历史没有 RPC 命令，直接扫 `~/.pi/agent/sessions/*/*.jsonl` 读首行和第一条用户消息。
- 扩展的 `select` / `input` / `editor` 对话框未实现，一律回 `cancelled`，避免 pi 卡死（`confirm` / `notify` / `setTitle` 已支持）。
- 队列（steering / followUp）会发出去，但界面还没渲染队列列表。
