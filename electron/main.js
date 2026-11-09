// Electron main process: window/lifecycle, the pi RPC child, and the bridge
// between pi's extension UI protocol and the renderer. Feature areas live in
// their own modules (sessions, projects, git, tasks, workspace, config, diag).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { createAgentBoard } from "./agents.js";
import { AGENT_DIR, APP_HOME, ensureAppHome } from "./app-home.js";
import { parseAttachment } from "./attachments.js";
import { installAutoRouter } from "./auto-router.js";
import { installBundledExtensions } from "./bundled-extensions.js";
import { registerConfigHandlers } from "./config-ipc.js";
import { registerDiagHandlers } from "./diag.js";
import { registerGitHandlers } from "./git.js";
import { safeHandle } from "./ipc.js";
import { optionalString, requireObject, requireString } from "./ipc-helpers.js";
import { logLine, recordLine } from "./logs.js";
import {
  cliVersion,
  PI_BG_INSTRUCTIONS,
  PiProcess,
  probeCli,
  resolveRuntime,
  runtimeVersion,
} from "./pi-process.js";
import { registerProjectHandlers } from "./projects.js";
import { installPiMobileExtension } from "./remote-extension.js";
import { startRemoteTunnel, stopRemoteTunnel } from "./remote-tunnel.js";
import { createScheduler } from "./schedules.js";
import { scanSessions } from "./session-files.js";
import { createSessionPool } from "./session-pool.js";
import { registerSessionHandlers } from "./sessions.js";
import { createTaskManager, installTermCli } from "./tasks.js";
import { installHrSkills } from "./hr-skills.js";
import { installPlanModeExtension } from "./plan-mode-extension.js";
import { installTableExtension } from "./table-extension.js";
import { installTodoExtension } from "./todo-extension.js";
import { registerUpdater } from "./updater.js";
import { registerUsageHandlers } from "./usage-ipc.js";
import { approvePreviewFile, registerWorkspaceHandlers } from "./workspace.js";
import {
  listMessageAttachments,
  recordMessageAttachments,
  saveAttachment,
} from "./attachments-store.js";

// ---------------------------------------------------------------- wiring

let win = null;

function send(record) {
  if (win && !win.isDestroyed()) win.webContents.send("pi:event", record);
}

process.on("uncaughtException", (err) => logLine("uncaught", err));
process.on("unhandledRejection", (err) => logLine("unhandled-rejection", err));

const pendingDialogs = new Set();
const taskManager = createTaskManager({ userDataDir: APP_HOME, send });

// 并行 agent 任务板（独立 pi 子进程，见 agents.js）
const agentBoard = createAgentBoard({ send, termEnv: () => piEnv(resolveRuntime()), agentDir: AGENT_DIR });
const scheduler = createScheduler({
  userDataDir: app.getPath("userData"),
  fire: (s) => {
    void agentBoard
      .start({ name: s.name, cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir(), message: s.message })
      .then(() => send({ type: "ui_notify", message: `定时任务「${s.name}」已派出`, notifyType: "info" }));
  },
});
safeHandle("board:list", () => agentBoard.list());
safeHandle("board:run", (_e, payload) => {
  const { name, cwd, message } = requireObject(payload, "payload");
  requireString(message, "message");
  const dir = typeof cwd === "string" && cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  return agentBoard.start({ name: optionalString(name, "name"), cwd: dir, message });
});
safeHandle("board:stop", (_e, id) => agentBoard.stop(requireString(id, "id")));

// 定时任务（每天 HH:MM 触发，派给并行 agent 板）
safeHandle("schedules:list", () => scheduler.list());
safeHandle("schedules:save", (_e, payload) => {
  const p = requireObject(payload, "payload");
  try { return scheduler.save(p); } catch (err) { return { ok: false, error: err.message }; }
});
safeHandle("schedules:delete", (_e, id) => scheduler.remove(requireString(id, "id")));

// 并行会话 v2：追问 / 中断（进程保活）
safeHandle("board:message", async (_e, payload) => {
  const { id, message } = requireObject(payload, "payload");
  return agentBoard.message(requireString(id, "id"), requireString(message, "message"));
});
safeHandle("board:abort", (_e, id) => agentBoard.abort(requireString(id, "id")));

// 多会话池：每个会话一个 pi 进程。主聊天界面显示 activeSession，
// 切会话只切这个指针，后台会话继续跑（不再被 switch_session 打断）。
let activeSession = null;

const pool = createSessionPool({
  send(rec) {
    if (rec.type === "extension_ui_request") {
      handleExtensionUi(rec);
      return;
    }
    if (rec.type === "pi_stderr") {
      process.stderr.write(rec.text);
      recordLine("pi-stderr", rec.text.trimEnd().slice(0, 500));
      return;
    }
    send(rec);
  },
  makeEnv: (rt) => piEnv(rt),
  buildArgs: async (sessionFile) => {
    const runtime = resolveRuntime();
    const probe = await probeCli(runtime);
    const isolationPreload = path.join(app.getPath("userData"), "pi-isolation-preload.cjs");
    try {
      fs.copyFileSync(path.join(import.meta.dirname, "pi-isolation-preload.cjs"), isolationPreload);
    } catch (err) {
      logLine("pi", "isolation preload 复制失败（跳过）:", err);
    }
    const argv = [
      ...(fs.existsSync(isolationPreload) ? ["--require", isolationPreload] : []),
      runtime.cli,
      "--mode",
      "rpc",
    ];
    if (probe.appendPrompt) argv.push("--append-system-prompt", PI_BG_INSTRUCTIONS);
    if (sessionFile && fs.existsSync(sessionFile)) argv.push("--session", sessionFile);
    return { runtime, argv };
  },
  activeKey: () => activeSession,
});

// ---------------------------------------------------------------- pi lifecycle

// 主 pi 与并行 agent 子进程共用的环境（隔离目录 + pi-bg 桥）
function piEnv(rt) {
  return {
    ...process.env,
    ...rt.env,
    PATH: [taskManager.paths.binDir, path.dirname(rt.node), process.env.PATH ?? ""].join(path.delimiter),
    PI_DESKTOP_TERM_SOCK: taskManager.paths.sock,
    PI_CODING_AGENT_DIR: AGENT_DIR,
    PI_MEMORY_DIR: path.join(AGENT_DIR, "memory"),
    ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
  };
}

// Boots are serialised: a rapid project switch waits for the previous start
// instead of interleaving two poll loops.
let bootLock = Promise.resolve();
let newSessionSeq = 0;

async function startPi(cwd, sessionFile = null) {
  // 切到目标会话（null = 新会话，由 pi 分配文件）；其余会话进程保持运行。
  // 注意：activeSession 先保持旧值，等新进程起来再切换，避免 ensure 期间
  // 事件被路由到错误会话。
  pendingDialogs.clear();
  send({ type: "ui_dialog_clear" });

  await pool.ensure(sessionFile, cwd, { active: true });
  activeSession = sessionFile;
  pool.activate(sessionFile);

  const rt = resolveRuntime();
  const version = (await cliVersion(rt)) ?? runtimeVersion(rt);
  logLine("pi", `session ready: ${sessionFile ?? "(new)"} in ${cwd} (pi v${version})`);
  return { rt, version };
}

// Extension text is written for a TUI; strip CSI/OSC escapes and control chars.
function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

// 池里缓存的扩展 UI 是 TUI 原文（可能带 ANSI）；返回渲染层前统一清洗。
function cleanUiSnapshot(ui) {
  return {
    widgets: Object.fromEntries(
      Object.entries(ui?.widgets ?? {}).map(([key, value]) => [
        key,
        { lines: (value.lines ?? []).map(stripAnsi), placement: value.placement },
      ]),
    ),
    statuses: Object.fromEntries(
      Object.entries(ui?.statuses ?? {})
        .map(([key, value]) => [key, stripAnsi(value)])
        .filter(([, value]) => value),
    ),
  };
}

// Dialog requests block pi until answered, so every one of them gets a reply.
function handleExtensionUi(req) {
  if (req.method === "confirm") {
    // 走应用内卡片而不是系统 message box：计划审批要把整份 markdown 计划
    // 展示给用户（ZCode 的计划审批也是输入框上方的卡片，而不是原生弹窗）。
    pendingDialogs.add(req.id);
    send({
      type: "ui_dialog",
      dialog: {
        id: req.id,
        method: "confirm",
        title: req.title,
        message: req.message,
      },
    });
    return;
  }
  if (req.method === "notify") {
    send({ type: "ui_notify", message: stripAnsi(req.message), notifyType: req.notifyType ?? "info" });
    return;
  }
  if (req.method === "setTitle") {
    send({ type: "ui_title", title: req.title });
    return;
  }
  // Extensions use setStatus to push live status text (e.g. a git extension's
  // current branch). An empty statusText means "clear this key".
  if (req.method === "setStatus") {
    send({ type: "ui_status", key: req.statusKey, text: stripAnsi(req.statusText) });
    return;
  }
  if (req.method === "setWidget") {
    send({ type: "ui_widget", key: req.widgetKey, lines: (req.widgetLines ?? []).map(stripAnsi), placement: req.widgetPlacement === "belowEditor" ? "below" : "above" });
    return;
  }
  // select / input / editor are answered from the renderer; pi keeps the
  // request open until pi:uiRespond writes the matching response.
  if (["select", "input", "editor"].includes(req.method)) {
    pendingDialogs.add(req.id);
    send({
      type: "ui_dialog",
      dialog: {
        id: req.id,
        method: req.method,
        title: req.title,
        options: req.options,
        placeholder: req.placeholder,
        prefill: req.prefill,
      },
    });
  }
}

// ---------------------------------------------------------------- window

// 关闭到托盘（Windows/Linux）：点 X 隐藏进后台，托盘右键退出。macOS 保持
// 惯例（红叉只关窗口，Dock 常驻）。
let tray = null;
let quitting = false;
const trayNotified = false;

function trayIcon() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath ?? "", "pi.png")
    : path.join(import.meta.dirname, "..", "build", "icon.png");
  // Windows 托盘按 16px 显示，大图直接缩会有锯齿，先缩成小图
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

// Windows 任务栏按钮跟随窗口图标；不显式设置时从 exe 资源解析，而 Windows 的
// 图标缓存按路径缓存，频繁覆盖安装后经常回落到旧的 Electron 默认图标。显式给
// 多尺寸 .ico，绕开缓存。macOS 由 .icns/Dock 负责；Linux 读不了 .ico 时返回
// undefined，维持原状（AppImage 自带图标）。
function windowIcon() {
  if (process.platform === "darwin") return undefined;
  const file = app.isPackaged
    ? path.join(process.resourcesPath ?? "", "pi.ico")
    : path.join(import.meta.dirname, "..", "build", "icon.ico");
  try {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  } catch {}
  return undefined;
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Pi");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主界面", click: showWindow },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 620,
    minHeight: 420,
    // macOS 保留红绿灯；Windows/Linux 去掉系统标题栏，用自绘栏（渲染层
    // header 即拖拽区，窗口控制按钮经 IPC）。
    frame: process.platform === "darwin",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#14151a",
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // 点 X 不退出：隐藏到托盘，pi 子进程继续在后台跑（不弹气泡，托盘图标本身即提示）
  if (process.platform !== "darwin") {
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
    });
  }
  // 自绘标题栏的窗口状态同步：最大化按钮需要知道当前状态
  const pushMaximized = () => send({ type: "win_maximized", value: win.isMaximized() });
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
  if (process.env.PI_DEV_URL) {
    win.loadURL(process.env.PI_DEV_URL);
  } else {
    win.loadFile(path.join(import.meta.dirname, "..", "dist", "index.html"));
  }

  // 4K 适配：Windows 缩放 100% 的大屏（物理宽 ≥3000 且系统缩放 <125%）上
  // 1x 渲染的 UI 会小得不可用，按有效宽度给一个默认缩放；用户手动缩放后以
  // 持久化值为准。
  win.webContents.on("did-finish-load", () => applyStoredZoom());

  win.webContents.setWindowOpenHandler(({ url }) => openExternal(url));

  // 从外部拖入文件时 Electron 默认会导航到 file:// 地址（整页离开应用），
  // 这也是"拖进去没反应"的主因之一。除应用自身页面外一律拒绝导航。
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      // http(s) 交给系统浏览器，file:// 静默忽略（拖拽文件的导航属于此类）
      if (/^https?:/i.test(url)) openExternal(url);
    }
  });

  // 渲染层（React drop handler）负责真正的接收；这里只兜住"没落在输入框上"
  // 的拖放，避免默认行为把文件当导航处理。
  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(`
      (() => {
        if (window.__piDragGuard) return;
        window.__piDragGuard = true;
        // 拖到窗口任意位置都不导航；不 preventDefault on drop 的默认行为会打开文件
        window.addEventListener("dragover", (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault();
        });
        window.addEventListener("drop", (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault();
        });
      })();
    `).catch(() => null);
  });
}

// ------------------------------------------------------------- 界面缩放

// 对齐 ZCode / opencode：不做按屏幕自动推断（猜不准且与系统缩放打架），
// 缩放是显式的用户设置——持久化于 ui.json，Ctrl+=/- 步进 10%，Ctrl+0 复位，
// 设置页提供档位。参考：ZCode 按 zoomLevel 持久化默认 0；opencode wireZoom。
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 2.5;

const clampZoom = (value) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(value) * 100) / 100));

function applyStoredZoom() {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(clampZoom(readUiPrefs().zoomFactor ?? 1));
}

function setZoomFactorPersisted(factor) {
  if (!win || win.isDestroyed()) return null;
  const next = clampZoom(factor);
  win.webContents.setZoomFactor(next);
  writeUiPrefs({ zoomFactor: next });
  return next;
}

safeHandle("ui:zoomGet", () => clampZoom(readUiPrefs().zoomFactor ?? 1));

// 每模型思考档位偏好：存在我们自己的 ui.json（pi 不碰这个文件）。
// pi 的 settings.json 被它的进程内存整个握着，旁路写会被下次保存覆盖、
// RPC 也没有 persist 选项；改为渲染层在 boot/切会话/切模型后按这里的
// 记忆主动 set_thinking_level 注入。
safeHandle("ui:getThinkingPrefs", () => readUiPrefs().thinkingLevels ?? {});
safeHandle("ui:setThinkingPref", (_e, { provider, modelId, level } = {}) => {
  requireString(provider, "provider");
  requireString(modelId, "modelId");
  requireString(level, "level");
  const current = readUiPrefs().thinkingLevels ?? {};
  current[`${provider}/${modelId}`] = level;
  writeUiPrefs({ thinkingLevels: current });
  return { ok: true };
});

// ------------------------------------------------- 自绘标题栏的窗口控制

safeHandle("win:minimize", () => {
  win?.minimize();
  return { ok: true };
});

safeHandle("win:toggleMaximize", () => {
  if (!win || win.isDestroyed()) return { ok: false };
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return { ok: true, maximized: win.isMaximized() };
});

// 走 win.close()：Windows/Linux 被 close 拦截转为隐藏到托盘，与原生 X 一致
safeHandle("win:closeApp", () => {
  win?.close();
  return { ok: true };
});

safeHandle("win:state", () => {
  if (!win || win.isDestroyed()) return { maximized: false };
  return { maximized: win.isMaximized() };
});

safeHandle("ui:zoom", (_e, { delta } = {}) => {
  if (!win || win.isDestroyed()) return { ok: false };
  const current = win.webContents.getZoomFactor();
  return { ok: true, factor: setZoomFactorPersisted(current + Number(delta ?? 0.1)) };
});

safeHandle("ui:zoomReset", () => {
  const factor = setZoomFactorPersisted(1);
  return factor === null ? { ok: false } : { ok: true, factor };
});

// 通用 UI 偏好（侧栏折叠等）：键值都进 ui.json，启动时读回
safeHandle("ui:getPref", (_e, { key } = {}) => {
  const k = requireString(key, "key");
  return { value: readUiPrefs()[k] ?? null };
});
safeHandle("ui:setPref", (_e, { key, value } = {}) => {
  const k = requireString(key, "key");
  writeUiPrefs({ [k]: value });
  return { ok: true };
});

safeHandle("ui:zoomSet", (_e, { factor } = {}) => {
  const value = Number(factor);
  if (!Number.isFinite(value)) return { ok: false, error: "无效缩放值" };
  const next = setZoomFactorPersisted(value);
  return next === null ? { ok: false } : { ok: true, factor: next };
});

// ------------------------------------------------------------ ui prefs (zoom)

const uiPrefsFile = () => path.join(app.getPath("userData"), "ui.json");

const readUiPrefs = () => {
  try {
    return JSON.parse(fs.readFileSync(uiPrefsFile(), "utf8")) ?? {};
  } catch {
    return {};
  }
};

const writeUiPrefs = (patch) => {
  try {
    fs.writeFileSync(
      uiPrefsFile(),
      `${JSON.stringify({ ...readUiPrefs(), ...patch }, null, 2)}\n`,
    );
  } catch {}
};

// Only http(s) may leave the app; file:// or custom schemes stay local.
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(url);
    } else {
      logLine("openExternal", "blocked non-http(s) url", url);
    }
  } catch {
    logLine("openExternal", "blocked invalid url", url);
  }
  return { action: "deny" };
}

// Harden webviews: no window opening, no Node, no extra preload.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (_e, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      const src = String(params.src ?? "");
      if (!/^https?:\/\//i.test(src)) params.src = "about:blank";
    });
  }
});

// ---------------------------------------------------------------- ipc

// 上次使用的工作区：启动无参时恢复，而不是退回用户根目录。
const lastWorkspaceFile = () => path.join(app.getPath("userData"), "last-workspace.json");

const readLastWorkspace = () => {
  try {
    const data = JSON.parse(fs.readFileSync(lastWorkspaceFile(), "utf8"));
    return typeof data.cwd === "string" && data.cwd ? data.cwd : null;
  } catch {
    return null;
  }
};

const writeLastWorkspace = (cwd) => {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(lastWorkspaceFile(), `${JSON.stringify({ cwd, at: Date.now() }, null, 2)}\n`);
  } catch {}
};

safeHandle("pi:start", async (_e, { cwd, sessionFile = null } = {}) => {
  const saved = readLastWorkspace();
  const resolved =
    cwd && fs.existsSync(cwd)
      ? cwd
      : saved && fs.existsSync(saved)
        ? saved
        : os.homedir();
  const run = async () => {
    await startPi(resolved, sessionFile);
    writeLastWorkspace(resolved);
    // Cold start: get_state can answer before the session/model exist, so poll.
    let state = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      state = await pool.command(activeSession, { type: "get_state" }).catch((e) => ({ error: String(e) }));
      if (process.env.PI_DEBUG) recordLine("boot-poll", i, JSON.stringify(state).slice(0, 200));
      if (state?.data?.model) break;
    }
    const [models, messages] = await Promise.all([
      pool.command(activeSession, { type: "get_available_models" }).catch(() => null),
      pool.command(activeSession, { type: "get_messages" }).catch(() => null),
    ]);
    // 会话文件由 pi 分配（新会话第一次落盘后才拿到）；回传给渲染层做键。
    // 池里的槽也要跟着改键，否则后续 command 会落在不存在的 null 键上。
    const assigned =
      state?.data?.sessionFile ?? (sessionFile && fs.existsSync(sessionFile) ? sessionFile : null);
    if (assigned) {
      if (!sessionFile) pool.rebind(null, assigned);
      activeSession = assigned;
    }
    return {
      state: state?.data ?? null,
      models: models?.data?.models ?? [],
      messages: messages?.data?.messages ?? [],
      cwd: resolved,
      sessionFile: assigned,
      ui: cleanUiSnapshot(pool.uiSnapshot(activeSession)),
    };
  };
  // Serialise overlapping boots; the caller always gets the latest result.
  const result = bootLock.then(run, run);
  bootLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
});

// 新建会话：新开一个池槽（独立 pi 进程），不碰当前会话。
// 旧路径用 pi 的 new_session 是"替换当前进程里的会话"，会 teardown 正在跑的
// 回合——这正是"同项目开第二个会话就把第一个打断"的根因。
safeHandle("pi:createSession", async (_e, { cwd } = {}) => {
  const saved = readLastWorkspace();
  const resolved =
    cwd && fs.existsSync(cwd)
      ? cwd
      : saved && fs.existsSync(saved)
        ? saved
        : os.homedir();
  const run = async () => {
    const key = `__new-${Date.now()}-${++newSessionSeq}`;
    await pool.ensure(key, resolved, { active: true, fresh: true });
    activeSession = key;
    pendingDialogs.clear();
    let state = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      state = await pool.command(key, { type: "get_state" }).catch(() => null);
      if (state?.data?.model) break;
    }
    const assigned = state?.data?.sessionFile ?? null;
    if (assigned) {
      pool.rebind(key, assigned);
      activeSession = assigned;
    }
    const [models, messages] = await Promise.all([
      pool.command(activeSession, { type: "get_available_models" }).catch(() => null),
      pool.command(activeSession, { type: "get_messages" }).catch(() => null),
    ]);
    writeLastWorkspace(resolved);
    return {
      state: state?.data ?? null,
      models: models?.data?.models ?? [],
      messages: messages?.data?.messages ?? [],
      cwd: resolved,
      sessionFile: assigned,
      ui: cleanUiSnapshot(pool.uiSnapshot(activeSession)),
    };
  };
  const result = bootLock.then(run, run);
  bootLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
});

// 并排窗格：确保会话进程在跑（不改活动指针），并开始把它的完整事件转发给
// 渲染层；返回一份快照供窗格首帧渲染。
safeHandle("pi:sessionPane", async (_e, { sessionFile, cwd } = {}) => {
  const file = requireString(sessionFile, "sessionFile");
  const dir = typeof cwd === "string" && fs.existsSync(cwd) ? cwd : os.homedir();
  await pool.ensure(file, dir, { active: false });
  pool.observe(file, true);
  const [st, msgs] = await Promise.all([
    pool.command(file, { type: "get_state" }).catch(() => null),
    pool.command(file, { type: "get_messages" }).catch(() => null),
  ]);
  return {
    ok: Boolean(st?.data),
    error: st?.data ? undefined : "会话未就绪",
    state: st?.data ?? null,
    messages: msgs?.data?.messages ?? [],
  };
});

// 并排窗格/后台链路用的只读快照：不发事件、不改观察标记。
safeHandle("pi:sessionSnapshot", async (_e, { sessionFile } = {}) => {
  const file = requireString(sessionFile, "sessionFile");
  const [st, msgs] = await Promise.all([
    pool.command(file, { type: "get_state" }).catch(() => null),
    pool.command(file, { type: "get_messages" }).catch(() => null),
  ]);
  return { state: st?.data ?? null, messages: msgs?.data?.messages ?? [] };
});

// 窗格关闭/失焦后停止观察：后台事件回到"只发状态"的静默模式。
safeHandle("pi:unobserveSession", (_e, { sessionFile } = {}) => {
  const file = requireString(sessionFile, "sessionFile");
  return { ok: pool.observe(file, false) };
});

// 计划模式：状态存在会话文件旁边的 sidecar（扩展每次 tool_call 读它做拦截），
// 所以 UI 开关和模型主动 EnterPlanMode 共用一份事实，重启也不丢。
function planFlagFile(sessionFile) {
  const resolved = path.resolve(sessionFile);
  const root = path.resolve(AGENT_DIR);
  // 只允许写 agent 目录下的会话文件旁边，避免渲染层传任意路径做写入
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return `${resolved}.plan-mode.json`;
}

safeHandle("pi:getPlanMode", (_e, { sessionFile } = {}) => {
  const file = planFlagFile(requireString(sessionFile, "sessionFile"));
  if (!file) return { enabled: false };
  try {
    return { enabled: Boolean(JSON.parse(fs.readFileSync(file, "utf8")).enabled) };
  } catch {
    return { enabled: false };
  }
});

safeHandle("pi:setPlanMode", (_e, { sessionFile, enabled, autoApprove, chain } = {}) => {
  const file = planFlagFile(requireString(sessionFile, "sessionFile"));
  if (!file) return { ok: false, error: "无效会话路径" };
  try {
    const on = Boolean(enabled);
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          enabled: on,
          autoApprove: on ? Boolean(autoApprove) : false,
          chain: on ? Boolean(chain) : false,
          updatedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
    );
    return { ok: true, enabled: on };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 远程零配置入口：起 Cloudflare Quick Tunnel，并把临时 https 地址写进
// pi-mobile 的 config.json（publicUrl）。手机只走 HTTPS，hub 仍只监听回环。
safeHandle("remote:tunnelStart", async () => {
  const dir = path.join(AGENT_DIR, "pi-mobile");
  const file = path.join(dir, "config.json");
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const port = Number.isInteger(config.port) ? config.port : 7878;
  // 用户自己配了固定 HTTPS 反代就复用它，不再起临时隧道；
  // 上次应用留下的 trycloudflare 地址已经死了，不能复用。
  const configured =
    typeof config.publicUrl === "string" &&
    /^https:\/\//i.test(config.publicUrl) &&
    !/trycloudflare\.com/i.test(config.publicUrl);
  if (configured) return { ok: true, url: config.publicUrl, port, reused: true };
  const result = await startRemoteTunnel({
    appRoot: path.join(import.meta.dirname, ".."),
    port,
  });
  if (!result.ok) return result;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...config, port, publicUrl: result.url, tailscale: false }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ...result, port };
});

safeHandle("remote:tunnelStop", () => stopRemoteTunnel());

// 切换界面显示的会话：只切活动指针（后台会话进程继续跑，不中断）。
safeHandle("pi:switchSession", async (_e, { sessionFile, cwd } = {}) => {
  if (typeof sessionFile !== "string" || !sessionFile) return { ok: false, error: "缺少会话路径" };
  activeSession = sessionFile;
  pool.activate(sessionFile);
  const running = pool.isRunning(sessionFile);
  if (!running) {
    // 进程已被回收：按 --session 重新拉起（历史完整恢复）
    await startPi(cwd && fs.existsSync(cwd) ? cwd : os.homedir(), sessionFile);
  }
  return {
    ok: true,
    running: pool.isRunning(sessionFile),
    ui: cleanUiSnapshot(pool.uiSnapshot(sessionFile)),
  };
});

safeHandle("pi:send", async (_e, payload = {}) => {
  // payload 可带 sessionFile 定向发给某个会话（多会话并行时用）；
  // 不传则维持旧行为：发给当前活动会话。
  const { sessionFile, ...body } = payload ?? {};
  const target = typeof sessionFile === "string" && sessionFile ? sessionFile : activeSession;
  const res = await pool.command(target, body);
  return res.data ?? null;
});

// 附件解析：pdf/docx 提取文本、zip 解压到临时目录（渲染层把结果内联进 prompt）
// 附件落盘（聊天 chip 可点开预览）与按 (cwd, ts) 的消息索引
safeHandle("attachments:save", (_e, payload) => {
  const { name, dataBase64 } = requireObject(payload, "payload");
  return saveAttachment({ name: optionalString(name, "name"), dataBase64: requireString(dataBase64, "dataBase64") });
});
safeHandle("attachments:record", (_e, payload) => {
  const p = requireObject(payload, "payload");
  return recordMessageAttachments(p);
});
safeHandle("attachments:list", (_e, payload) => {
  const { cwd } = requireObject(payload, "payload");
  return listMessageAttachments({ cwd: optionalString(cwd, "cwd") });
});

safeHandle("attachments:parse", async (_e, payload) => {
  requireObject(payload, "payload");
  return parseAttachment(payload).catch((err) => ({ ok: false, error: err.message }));
});

// 通知点击唤起窗口（窗口可能正藏在托盘里）
safeHandle("pi:showWindow", async () => {
  showWindow();
  return { ok: true };
});

safeHandle("pi:pickFolder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: os.homedir(),
  });
  return canceled ? null : filePaths[0];
});

safeHandle("pi:reveal", (_e, target) => {
  if (typeof target !== "string" || !target) return { ok: false, error: "缺少路径" };
  return shell.openPath(target);
});

safeHandle("pi:uiRespond", (_e, { id, value, cancelled, confirmed } = {}) => {
  if (!pendingDialogs.has(id)) return { ok: false, error: "请求已失效" };
  pendingDialogs.delete(id);
  const payload = { type: "extension_ui_response", id };
  if (cancelled) payload.cancelled = true;
  else if (confirmed !== undefined) payload.confirmed = Boolean(confirmed);
  else payload.value = typeof value === "string" ? value : "";
  pool.write(activeSession, payload);
  return { ok: true };
});

// Dev-only helper so the dialog UI can be exercised without an extension.
if (process.env.PI_DEBUG) {
  safeHandle("pi:debugDialog", (_e, dialogRequest) => {
    const id = `debug-${Date.now()}`;
    pendingDialogs.add(id);
    send({ type: "ui_dialog", dialog: { ...dialogRequest, id } });
    return { ok: true, id };
  });

  // 调试/测试：注入一条 widget 事件（与扩展 setWidget 同一条渲染通路）
  safeHandle("pi:debugWidget", (_e, payload) => {
    const { key = "debug", lines = [], placement = "above" } = requireObject(payload, "payload");
    send({ type: "ui_widget", key, lines, placement });
    return { ok: true };
  });

  // 调试/测试：优雅退出（走真实 quit 路径：stopAll → 进程退出钩子 → app.quit），
  // 供验证"退出时回写"类逻辑；硬杀不会给主进程跑退出钩子的机会。
  // 调试/测试：把某个绝对路径登记进预览白名单（等价于用户在文件选择器里选中）
  safeHandle("files:debugApprove", (_e, absPath) => ({ ok: approvePreviewFile(absPath) }));

  safeHandle("pi:debugQuit", () => {
    setImmediate(() => app.quit());
    return { ok: true };
  });
}

// ---------------------------------------------------------------- modules

// 兼容层：session/project 等模块以「单个 pi」的形态调用（command/write/running），
// 这里把它们代理到当前活动会话的进程上。
const pi = {
  command: (payload, timeoutMs) => pool.command(activeSession, payload),
  write: (payload) => pool.write(activeSession, payload),
  get running() {
    return pool.isRunning(activeSession);
  },
  stop: () => pool.stop(activeSession),
};

registerSessionHandlers({ pi, dialog, shell });
registerProjectHandlers({ userDataDir: APP_HOME, scanSessions });
registerGitHandlers();
registerWorkspaceHandlers();
registerConfigHandlers({ send });
registerUpdater({ safeHandle, send });
registerUsageHandlers();
registerDiagHandlers({
  safeHandle,
  collect: async () => {
    const rt = resolveRuntime();
    const probe = await probeCli(rt);
    let session = "unavailable";
    try {
      const state = await pool.command(activeSession, { type: "get_state" });
      session = {
        sessionFile: state?.data?.sessionFile,
        model: state?.data?.model?.id,
        isStreaming: state?.data?.isStreaming,
      };
    } catch {}
    return {
      appHome: APP_HOME,
      agentDir: AGENT_DIR,
      runtime: {
        cli: rt.cli,
        node: rt.node,
        version: (await cliVersion(rt)) ?? runtimeVersion(rt),
        managed: Boolean(rt.installRoot),
        flags: probe,
      },
      piRunning: pool.count() > 0,
      session,
      tasks: taskManager.snapshot(),
    };
  },
});

// Task handlers live here so tasks.js stays Electron-free and testable.
safeHandle("term:run", (_e, { cmd, cwd, label, host } = {}) => {
  if (typeof cmd !== "string" || !cmd.trim()) return { ok: false, error: "命令不能为空" };
  const task = taskManager.startTask({ cmd, cwd, label, host, origin: "user" });
  return { id: task.id, cwd: task.cwd };
});
safeHandle("term:list", () => taskManager.listTasks());
safeHandle("term:out", (_e, id) => taskManager.listTasks().find((t) => t.id === id)?.output ?? "");
safeHandle("term:kill", (_e, id) => taskManager.killTask(id));
safeHandle("term:remove", (_e, id) => taskManager.removeTask(id));

// ---------------------------------------------------------------- lifecycle

// dev 与打包版共用 app name "pi-desktop"，默认会共用 %APPDATA%/pi-desktop：
// 缓存互斥报错，单实例锁也会被对方进程占住。dev 指到独立目录。
// PI_USER_DATA 优先：E2E 用独立目录，避免测试期间的 UI 偏好（侧栏折叠等）
// 写进开发者的真实 userData。
if (process.env.PI_USER_DATA) {
  app.setPath("userData", process.env.PI_USER_DATA);
} else if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "pi-desktop-dev"));
}
// 单实例（按 userData 目录隔离：dev 与打包版互不冲突）。二次启动时唤起已有
// 窗口，避免跑出第二个 pi 子进程、抢同一个任务桥管道。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  // Windows/Linux 默认带 File/Edit/View 菜单栏，与自绘标题栏冲突；macOS 的
  // 系统菜单（cmd+Q、复制粘贴加速键）不在窗口内，保留。
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  // In dev the process is Electron itself, so the Dock would show Electron's
  // icon; packaged builds get theirs from the bundle (.icns).
  if (!app.isPackaged && process.platform === "darwin") {
    try {
      app.dock.setIcon(path.join(import.meta.dirname, "..", "build", "icon.png"));
    } catch {}
  }
  // Windows 系统通知需要 AppUserModelID 与开始菜单快捷方式一致。dev/E2E 跑的
  // 是 electron.exe（Electron 默认图标），若与安装版共用同一个 AUMID，Windows 会
  // 把任务栏的该 AUMID 关联到 electron.exe 的图标——必须拆开。
  if (process.platform === "win32") {
    app.setAppUserModelId(app.isPackaged ? "dev.pi.desktop" : "dev.pi.desktop.dev");
  }
  // First run: create ~/.pi-desktop and migrate the user's pi config/sessions
  // so the app is fully self-contained. Must happen before pi starts.
  ensureAppHome();
  // The bridge and its CLI must exist before pi starts, since pi's bash tool
  // uses the injected PATH / env to reach them.
  installTermCli(APP_HOME);
  // auto 虚拟模型扩展（模型选择器里的 pi-desktop/auto：low→最便宜，high→最强）
  installAutoRouter(AGENT_DIR);
  installTodoExtension(AGENT_DIR);
  // 计划模式扩展：EnterPlanMode / ExitPlanMode 工具 + 只读工具闸门 + plan 文档
  installPlanModeExtension(AGENT_DIR);
  // 内置远程模块（pi-mobile）：手机扫码 / 网页端远程控制所有会话
  installPiMobileExtension(AGENT_DIR, path.join(import.meta.dirname, ".."));
  // 表格工具扩展：让模型能读写带公式的 xlsx（SheetJS 随应用分发给扩展目录）
  installTableExtension(AGENT_DIR, path.join(import.meta.dirname, "..", "node_modules", "xlsx"));
  // HR 文案技能包（员工沟通 / 会议纪要 / 活动方案），随应用分发
  installHrSkills(AGENT_DIR);
  scheduler.start();
  // 空闲会话回收：非活动且静默 10 分钟的 pi 进程停掉（切回时按 --session 重启）
  setInterval(() => pool.sweep(), 60_000).unref();
  // 内置扩展：首次启动（或应用升级后）离线装进 agent 目录，失败不阻塞启动
  void installBundledExtensions({
    resourcesPath: process.resourcesPath,
    agentDir: AGENT_DIR,
    runtime: resolveRuntime(),
    appVersion: app.getVersion(),
  }).catch((err) => logLine("bundled-ext", err));
  taskManager.startBridge();
  createWindow();
  if (process.platform !== "darwin") createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopRemoteTunnel();
  pool.stopAll();
  if (process.platform !== "darwin") app.quit();
});

let quitDrained = false;
app.on("before-quit", (event) => {
  quitting = true;
  // 先拦住退出：等全部 pi 子进程真正死透（各自的退出钩子跑完，槽位清理）
  // 再继续；2.5s 兜底，不会卡住退出。
  if (quitDrained) return;
  event.preventDefault();
  quitDrained = true;
  taskManager.stopBridge();
  stopRemoteTunnel();
  agentBoard.stopAll();
  scheduler.stop();
  Promise.race([pool.stopAll(), new Promise((r) => setTimeout(r, 2500))]).finally(() =>
    app.quit(),
  );
});
