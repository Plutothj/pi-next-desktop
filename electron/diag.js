// Diagnostics: an in-memory log ring plus an export handler. Colleagues can
// hand over one file with versions, environment, and recent errors.

import { app, dialog, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_LOG_LINES = 500;
const recent = [];

/** Adds a line to the diagnostic ring without writing to stderr. */
export function recordLine(scope, ...parts) {
  const detail = parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : String(part)))
    .join(" ");
  recent.push(`[${new Date().toISOString()}] [${scope}] ${detail}`);
  if (recent.length > MAX_LOG_LINES) recent.shift();
}

export function logLine(scope, ...parts) {
  recordLine(scope, ...parts);
  const detail = parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : String(part)))
    .join(" ");
  console.error(`[${scope}] ${detail}`);
}

export const recentLogs = () => recent.slice();

export function registerDiagHandlers({ safeHandle, collect }) {
  safeHandle("diag:export", async () => {
    const extra = (await collect?.().catch(() => ({}))) ?? {};
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const lines = [
      `Pi Desktop diagnostics — ${new Date().toISOString()}`,
      `app: ${app.getVersion()}`,
      `electron: ${process.versions.electron}  chrome: ${process.versions.chrome}  node: ${process.versions.node}`,
      `platform: ${process.platform} ${process.arch}  os: ${os.release()}`,
      `userData: ${app.getPath("userData")}`,
      ...Object.entries(extra).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
      "",
      "--- recent logs ---",
      ...recentLogs(),
    ];
    const text = `${lines.join("\n")}\n`;

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(os.homedir(), `pi-diagnostic-${stamp}.txt`),
    });
    if (canceled || !filePath) return { ok: false, error: "已取消" };
    fs.writeFileSync(filePath, text);
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "诊断信息已导出",
      detail: filePath,
      buttons: ["在 Finder 中显示", "好"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  });
}
