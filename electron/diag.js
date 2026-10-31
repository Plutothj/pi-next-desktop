// Diagnostics: wires the log ring into an export handler. Colleagues can hand
// over one file with versions, environment, and recent errors.

import { app, dialog, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recentLogs } from "./logs.js";

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
