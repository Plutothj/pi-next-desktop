// Session history: pi has no list RPC, so we read ~/.pi/agent/sessions
// directly. Also hosts session deletion, fork-at-entry, and HTML export.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireString, safeHandle } from "./ipc.js";
import { logLine } from "./diag.js";

// pi's session JSONL format version this build understands. File-level forks
// write that format by hand, so refuse unknown versions loudly instead of
// producing a file pi cannot load.
export const SUPPORTED_SESSION_VERSION = 3;

export const sessionsRoot = () => path.join(os.homedir(), ".pi", "agent", "sessions");

function sessionTitle(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = raw.split("\n");
  let header = null;
  let title = null;
  const changed = { added: 0, removed: 0 };
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    // Cheap substring pre-filters before JSON.parse: renames (session_info),
    // the first user message (only until a title exists), and tool calls
    // (the only records that change files).
    if (index > 0) {
      const mayRename = line.includes('"session_info"');
      const mayUser = !title && line.includes('"role":"user"');
      const mayTool = line.includes('"toolCall"');
      if (!mayRename && !mayUser && !mayTool) continue;
    }
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "session" && !header) header = rec;
    // Renames append a session_info entry; the last one wins.
    if (rec.type === "session_info" && rec.name) title = rec.name;
    if (!title && rec.type === "message" && rec.message?.role === "user") {
      const c = rec.message.content;
      const text = typeof c === "string" ? c : c?.find((b) => b.type === "text")?.text;
      if (text) title = text.replace(/\s+/g, " ").slice(0, 80);
    }
    if (rec.type === "message" && rec.message?.role === "assistant") {
      for (const block of rec.message.content ?? []) {
        if (block?.type !== "toolCall") continue;
        const args = block.arguments ?? {};
        const linesOf = (text) => (typeof text === "string" ? text.split("\n").length : 0);
        if (block.name === "write") changed.added += linesOf(args.content);
        if (block.name === "edit") {
          for (const edit of args.edits ?? [{ oldText: args.oldText, newText: args.newText }]) {
            changed.removed += linesOf(edit?.oldText);
            changed.added += linesOf(edit?.newText);
          }
        }
      }
    }
  }
  if (!header) return null;
  return {
    path: file,
    ...header,
    title: title ?? "新会话",
    mtime: fs.statSync(file).mtimeMs,
    changed,
  };
}

export function scanSessions() {
  const root = sessionsRoot();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const info = sessionTitle(path.join(root, dir.name, name));
      if (info) out.push(info);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function registerSessionHandlers({ pi, dialog, shell }) {
  safeHandle("pi:sessions", () => scanSessions());

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
      if (header?.type !== "session") return { ok: false, error: "会话文件格式异常" };
      if (Number(header.version) > SUPPORTED_SESSION_VERSION) {
        return {
          ok: false,
          error: `会话格式 v${header.version} 超出当前支持（v${SUPPORTED_SESSION_VERSION}），请升级 Pi Desktop`,
        };
      }

      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const newHeader = { ...header, id: newId, timestamp: now, parentSession: header.id };
      const fileTimestamp = now.replace(/[:.]/g, "-");
      const newFile = path.join(path.dirname(sessionFile), `${fileTimestamp}_${newId}.jsonl`);
      const lines = [JSON.stringify(newHeader), ...chain.map((entry) => JSON.stringify(entry))];
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
