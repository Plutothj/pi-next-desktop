// Shared IPC plumbing: one place to validate arguments, log failures, and
// keep the process from dying on an unexpected exception in a handler.

import { ipcMain } from "electron";
import { logLine } from "./diag.js";

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

export function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

export function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  return value;
}

export function requireObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value;
}

/** Resolves a cwd argument, falling back to the home directory. */
export function resolveDir(cwd, existsSync, homedir) {
  if (typeof cwd === "string" && cwd && existsSync(cwd)) return cwd;
  return homedir;
}
