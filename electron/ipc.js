// IPC plumbing that needs Electron. Pure helpers (validation, dir resolution)
// live in ipc-helpers.js so non-Electron modules can use them.

import { ipcMain } from "electron";
import { logLine } from "./logs.js";

/** Registers an ipcMain handler with uniform error logging. Errors still
 *  reject on the renderer side (callers rely on .catch). */
export function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      // Renderer panels fire requests while pi is still booting/restarting;
      // those rejections are expected and handled by callers.
      const message = err?.message ?? "";
      if (!message.includes("pi 未运行") && !message.includes("pi 重启中")) {
        logLine(`ipc:${channel}`, err);
      }
      throw err;
    }
  });
}
