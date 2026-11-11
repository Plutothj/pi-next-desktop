// Session IPC handlers. Pure file logic lives in session-files.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireString } from "./ipc-helpers.js";
import { safeHandle } from "./ipc.js";
import { logLine } from "./logs.js";
import { buildForkLines, searchSessions, sessionsRoot } from "./session-files.js";
import { scanSessionsIndexed } from "./session-index.js";

export function registerSessionHandlers({ pi, dialog, shell }) {
  // SQLite 元数据索引：只 stat 文件，没变的行直接查表（冷扫描不再重读 JSONL）
  safeHandle("pi:sessions", () => scanSessionsIndexed());
  safeHandle("pi:searchSessions", (_e, { query } = {}) => searchSessions(query));

  // pi's RPC fork only branches *before a user message*. For forking at an
  // arbitrary entry (e.g. an assistant reply) we build the new session file
  // ourselves — header + the parent chain up to the entry — then let pi
  // switch_session onto it.
  safeHandle("pi:forkSessionAt", async (_e, payload) => {
    const { entryId } = payload ?? {};
    requireString(entryId, "entryId");
    try {
      const state = await pi.command({ type: "get_state" });
      const sessionFile = state?.data?.sessionFile;
      if (!sessionFile) return { ok: false, error: "当前会话还没有落盘，无法分支" };
      const entriesRes = await pi.command({ type: "get_entries" });
      const entries = entriesRes?.data?.entries ?? [];
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const target = byId.get(entryId);
      if (!target) return { ok: false, error: "找不到该条目" };

      // Walk parentId back to the root; that chain is the branch to keep.
      const chain = [];
      for (let cur = target; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) {
        chain.unshift(cur);
      }

      const raw = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
      const header = JSON.parse(raw[0]);
      const { newId, lines } = buildForkLines(header, chain);
      const now = new Date().toISOString();
      const fileTimestamp = now.replace(/[:.]/g, "-");
      const newFile = path.join(path.dirname(sessionFile), `${fileTimestamp}_${newId}.jsonl`);
      fs.writeFileSync(newFile, `${lines.join("\n")}\n`);

      const switched = await pi.command({ type: "switch_session", sessionPath: newFile }).catch((err) => {
        // Don't leave a broken file behind if pi rejects it.
        try { fs.unlinkSync(newFile); } catch {}
        throw err;
      });
      if (switched?.data?.cancelled) {
        try { fs.unlinkSync(newFile); } catch {}
        return { ok: false, error: "分支被取消" };
      }
      return { ok: true, sessionFile: newFile };
    } catch (err) {
      logLine("fork", err);
      return { ok: false, error: err.message };
    }
  });

  // No delete RPC exists; remove the file ourselves. Deleting the live session
  // would leave pi writing to a ghost file, so switch it to a fresh one first.
  safeHandle("pi:deleteSession", async (_e, payload) => {
    const file = payload?.path;
    requireString(file, "path");
    try {
      const root = sessionsRoot();
      if (!file.endsWith(".jsonl") || !file.startsWith(root + path.sep)) {
        return { ok: false, error: "非法的会话文件路径" };
      }
      let switched = false;
      const state = await pi.command({ type: "get_state" }).catch(() => null);
      if (state?.data?.sessionFile === file) {
        await pi.command({ type: "new_session" });
        switched = true;
      }
      fs.unlinkSync(file);
      return { ok: true, switched };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // pi owns the HTML renderer; this is just save-dialog plumbing.
  safeHandle("pi:exportHtml", async () => {
    const state = await pi.command({ type: "get_state" }).catch(() => null);
    const sessionFile = state?.data?.sessionFile;
    const base = sessionFile ? path.basename(sessionFile, ".jsonl") : "session";
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(os.homedir(), `${base}.html`),
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (canceled || !filePath) return { ok: false, error: "已取消" };
    const res = await pi.command({ type: "export_html", outputPath: filePath });
    const outPath = res?.data?.path ?? filePath;
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "会话已导出",
      detail: outPath,
      buttons: ["在 Finder 中显示", "好"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) shell.showItemInFolder(outPath);
    return { ok: true, path: outPath };
  });
}
