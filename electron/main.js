// Electron main process: window/lifecycle, the pi RPC child, and the bridge
// between pi's extension UI protocol and the renderer. Feature areas live in
// their own modules (sessions, projects, git, tasks, workspace, config, diag).

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_HOME, AGENT_DIR, ensureAppHome } from "./app-home.js";
import { registerConfigHandlers } from "./config-ipc.js";
import { logLine, recordLine } from "./logs.js";
import { registerDiagHandlers } from "./diag.js";
import { registerGitHandlers } from "./git.js";
import { safeHandle } from "./ipc.js";
import {
  PI_BG_INSTRUCTIONS,
  PiProcess,
  cliVersion,
  probeCli,
  resolveRuntime,
  runtimeVersion,
} from "./pi-process.js";
import { registerProjectHandlers } from "./projects.js";
import { scanSessions } from "./session-files.js";
import { registerSessionHandlers } from "./sessions.js";
import { createTaskManager, installTermCli } from "./tasks.js";
import { registerWorkspaceHandlers } from "./workspace.js";
import { registerUpdater } from "./updater.js";
import { registerUsageHandlers } from "./usage-ipc.js";

// ---------------------------------------------------------------- wiring

let win = null;

function send(record) {
  if (win && !win.isDestroyed()) win.webContents.send("pi:event", record);
}

process.on("uncaughtException", (err) => logLine("uncaught", err));
process.on("unhandledRejection", (err) => logLine("unhandled-rejection", err));

const pendingDialogs = new Set();
const taskManager = createTaskManager({ userDataDir: APP_HOME, send });

const pi = new PiProcess({
  onRecord(rec) {
    if (rec.type === "extension_ui_request") {
      handleExtensionUi(rec);
      return;
    }
    send(rec);
  },
  onExit({ code, signal }) {
    pendingDialogs.clear();
    send({ type: "ui_dialog_clear" });
    send({ type: "child_exit", code, signal });
  },
  onStderr(data) {
    process.stderr.write(data);
    recordLine("pi-stderr", data.trimEnd().slice(0, 500));
  },
});

// ---------------------------------------------------------------- pi lifecycle

// Boots are serialised: a rapid project switch waits for the previous start
// instead of interleaving two poll loops.
let bootLock = Promise.resolve();

async function startPi(cwd) {
  pi.stop();
  pendingDialogs.clear();
  send({ type: "ui_dialog_clear" });

  const rt = resolveRuntime();
  const probe = await probeCli(rt);
  // 隔离 preload：第三方扩展硬编码 ~/.pi/agent 的读写重定向到隔离目录。
  // 打包版 pi 用普通 node 跑 extraResources，读不了 asar，所以先复制到 userData。
  const isolationPreload = path.join(app.getPath("userData"), "pi-isolation-preload.cjs");
  try {
    fs.copyFileSync(path.join(import.meta.dirname, "pi-isolation-preload.cjs"), isolationPreload);
  } catch (err) {
    logLine("pi", "isolation preload 复制失败（跳过）:", err);
  }
  // --require 须在脚本路径之前，node 会先加载它再启动 cli.js
  const argv = [
    ...(fs.existsSync(isolationPreload) ? ["--require", isolationPreload] : []),
    rt.cli,
    "--mode",
    "rpc",
  ];
  // Unknown flags make pi exit on startup; probe the CLI before adding one.
  if (probe.appendPrompt) {
    argv.push("--append-system-prompt", PI_BG_INSTRUCTIONS);
  } else {
    send({
      type: "ui_notify",
      message: "当前 pi 版本不支持 --append-system-prompt，pi-bg 长任务指引未注入（pi-bg 仍可用）",
      notifyType: "warning",
    });
  }

  pi.start({
    node: rt.node,
    argv,
    cwd,
    env: {
      ...process.env,
      ...rt.env,
      // pi-bg must resolve from the agent's bash tool.
      PATH: [taskManager.paths.binDir, path.dirname(rt.node), process.env.PATH ?? ""].join(path.delimiter),
      PI_DESKTOP_TERM_SOCK: taskManager.paths.sock,
      // Isolated config/sessions/extensions: ~/.pi-desktop/agent
      PI_CODING_AGENT_DIR: AGENT_DIR,
      // pi-memory 等记忆扩展默认写 ~/.pi/agent/memory，只认这个变量；
      // 指回隔离目录，桌面「记忆」页才能看到。
      PI_MEMORY_DIR: path.join(AGENT_DIR, "memory"),
      ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
    },
  });
  const version = (await cliVersion(rt)) ?? runtimeVersion(rt);
  logLine("pi", `started ${rt.cli} (v${version}) in ${cwd}`);
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

// Dialog requests block pi until answered, so every one of them gets a reply.
function handleExtensionUi(req) {
  const reply = (values) => {
    pi.write({ type: "extension_ui_response", id: req.id, ...values });
  };

  if (req.method === "confirm") {
    dialog
      .showMessageBox(win, {
        type: "question",
        title: req.title ?? "Pi",
        message: req.title ?? "确认",
        detail: req.message ?? "",
        buttons: ["取消", "确认"],
        defaultId: 1,
        cancelId: 0,
      })
      .then(({ response }) => reply({ confirmed: response === 1 }));
    return;
  }
  if (req.method === "notify") {
    send({ type: "ui_notify", message: req.message, notifyType: req.notifyType ?? "info" });
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
    send({ type: "ui_widget", key: req.widgetKey, lines: (req.widgetLines ?? []).map(stripAnsi) });
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
let trayNotified = false;

function trayIcon() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath ?? "", "pi.png")
    : path.join(import.meta.dirname, "..", "build", "icon.png");
  // Windows 托盘按 16px 显示，大图直接缩会有锯齿，先缩成小图
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
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
    titleBarStyle: "hiddenInset",
    backgroundColor: "#14151a",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // 点 X 不退出：隐藏到托盘，pi 子进程继续在后台跑
  if (process.platform !== "darwin") {
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
      if (!trayNotified) {
        trayNotified = true;
        // Windows 气泡：告知程序仍在运行、如何退出
        if (process.platform === "win32" && typeof tray?.displayBalloon === "function") {
          tray.displayBalloon({
            iconType: "info",
            title: "Pi 仍在运行",
            content: "已最小化到系统托盘。点击托盘图标恢复窗口，右键托盘图标可退出。",
          });
        }
      }
    });
  }
  if (process.env.PI_DEV_URL) {
    win.loadURL(process.env.PI_DEV_URL);
  } else {
    win.loadFile(path.join(import.meta.dirname, "..", "dist", "index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => openExternal(url));
}

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

safeHandle("pi:start", async (_e, { cwd } = {}) => {
  const saved = readLastWorkspace();
  const resolved =
    cwd && fs.existsSync(cwd)
      ? cwd
      : saved && fs.existsSync(saved)
        ? saved
        : os.homedir();
  const run = async () => {
    await startPi(resolved);
    writeLastWorkspace(resolved);
    // Cold start: get_state can answer before the session/model exist, so poll.
    let state = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      state = await pi.command({ type: "get_state" }).catch((e) => ({ error: String(e) }));
      if (process.env.PI_DEBUG) recordLine("boot-poll", i, JSON.stringify(state).slice(0, 200));
      if (state?.data?.model) break;
    }
    const [models, messages] = await Promise.all([
      pi.command({ type: "get_available_models" }).catch(() => null),
      pi.command({ type: "get_messages" }).catch(() => null),
    ]);
    return {
      state: state?.data ?? null,
      models: models?.data?.models ?? [],
      messages: messages?.data?.messages ?? [],
      cwd: resolved,
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

safeHandle("pi:send", async (_e, payload) => {
  const res = await pi.command(payload);
  return res.data ?? null;
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
  pi.write(payload);
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
}

// ---------------------------------------------------------------- modules

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
      const state = await pi.command({ type: "get_state" });
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
      piRunning: pi.running,
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
if (!app.isPackaged) {
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
  // First run: create ~/.pi-desktop and migrate the user's pi config/sessions
  // so the app is fully self-contained. Must happen before pi starts.
  ensureAppHome();
  // The bridge and its CLI must exist before pi starts, since pi's bash tool
  // uses the injected PATH / env to reach them.
  installTermCli(APP_HOME);
  taskManager.startBridge();
  createWindow();
  if (process.platform !== "darwin") createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  pi.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  pi.stop();
  taskManager.stopBridge();
});
