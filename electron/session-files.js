// Pure session-file logic (no Electron imports): scanning, title parsing,
// and fork-file construction. sessions.js wires these into IPC handlers.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "./app-home.js";

// pi's session JSONL format version this build understands. File-level forks
// write that format by hand, so refuse unknown versions loudly instead of
// producing a file pi cannot load.
export const SUPPORTED_SESSION_VERSION = 3;

export const sessionsRoot = () => path.join(AGENT_DIR, "sessions");

// Sessions are re-scanned on every refresh; cache parses by (mtime, size) so
// unchanged files cost one stat each instead of a full read.
const BIG_FILE_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const CACHE_LIMIT = 2000;
const titleCache = new Map();

/** Reads a session file, falling back to head+tail slices for huge files. */
function readLines(file, size) {
  if (size <= BIG_FILE_BYTES) {
    return fs.readFileSync(file, "utf8").split("\n");
  }
  const fd = fs.openSync(file, "r");
  try {
    const headLength = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLength);
    fs.readSync(fd, head, 0, headLength, 0);
    const tailStart = Math.min(headLength, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - tailStart);
    if (tail.length > 0) fs.readSync(fd, tail, 0, tail.length, tailStart);
    // Lines spanning the cut fail JSON.parse and are skipped by callers.
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`.split("\n");
  } finally {
    fs.closeSync(fd);
  }
}

// 附件块（attachments.ts 的 wrap() 生成）与未解析标记：会话文件里是真相，
// 但侧栏标题属于展示语义——不能用附件正文开头当标题。
const ATTACHMENT_BLOCK_RE = /<attachment\s+[^>]*>[\s\S]*?<\/attachment>/g;
const ATTACHMENT_MARK_RE = /【附件\s+[^】\n]*】/g;
const ATTACHMENT_NAME_RE = /<attachment\s+name="([^"]+)"/;
// pi 的 `/skill:name` 会把整篇 SKILL.md 展开进用户消息：标题只留用户参数/技能名
const SKILL_BLOCK_RE = /<skill\s+name="([^"]*)"[^>]*>[\s\S]*?<\/skill>/;

function titleFromUserText(text) {
  const name = text.match(ATTACHMENT_NAME_RE)?.[1];
  const skill = text.match(SKILL_BLOCK_RE)?.[1];
  const clean = text
    .replace(SKILL_BLOCK_RE, " ")
    .replace(ATTACHMENT_BLOCK_RE, " ")
    .replace(ATTACHMENT_MARK_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean) return clean.slice(0, 80);
  if (skill) return `技能：${skill}`;
  if (name) return `${name}（附件）`;
  return null;
}

function parseSession(file, size) {
  let raw;
  try {
    raw = readLines(file, size).join("\n");
  } catch {
    return null;
  }
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
      // 附件的解析正文是给模型的：标题只用用户自己写的字；只发了附件就用文件名
      if (text) title = titleFromUserText(text);
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
    changed,
  };
}

/** Parses one session file, memoised by (mtime, size). */
export function sessionTitle(file, stat) {
  let s = stat;
  try {
    s = s ?? fs.statSync(file);
  } catch {
    return null;
  }
  const cached = titleCache.get(file);
  if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
    return { ...cached.info, mtime: s.mtimeMs };
  }
  const info = parseSession(file, s.size);
  if (!info) return null;
  info.mtime = s.mtimeMs;
  if (titleCache.size > CACHE_LIMIT) titleCache.clear();
  titleCache.set(file, { mtimeMs: s.mtimeMs, size: s.size, info });
  return info;
}

export function scanSessions(root = sessionsRoot()) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(root, dir.name, name);
      const info = sessionTitle(full);
      if (info) out.push(info);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 会话全文搜索：显式动作才触发（O(总字节)，与 scanSessions 同源已知代价）。
// 上限：最近 200 个文件、单文件 20MB、命中 30 条即止。
export function searchSessions(query, root = sessionsRoot()) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return { hits: [], scanned: 0, truncated: false };
  const sessions = scanSessions(root).slice(0, 200);
  const hits = [];
  let truncated = false;

  for (const session of sessions) {
    if (hits.length >= 30) {
      truncated = true;
      break;
    }
    let content;
    try {
      if (fs.statSync(session.path).size > 20 * 1024 * 1024) continue;
      content = fs.readFileSync(session.path, "utf8");
    } catch {
      continue;
    }
    const at = content.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    // 命中点上下文：剥掉 JSON 结构噪音，给一段可读片段
    const snippet = content
      .slice(Math.max(0, at - 120), at + 240)
      .replace(/\\n/g, " ")
      .replace(/[{}"[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
    hits.push({
      path: session.path,
      title: session.title ?? "新会话",
      cwd: session.cwd ?? null,
      mtime: session.mtime,
      snippet,
    });
  }
  return { hits, scanned: sessions.length, truncated };
}

/**
 * Builds the contents of a file-level fork: new header (parentSession points
 * at the source session) plus the ancestor chain of the target entry.
 * Throws on unknown session formats so we never write a file pi cannot load.
 */
export function buildForkLines(header, chain) {
  if (header?.type !== "session") throw new Error("会话文件格式异常");
  if (Number(header.version) > SUPPORTED_SESSION_VERSION) {
    throw new Error(
      `会话格式 v${header.version} 超出当前支持（v${SUPPORTED_SESSION_VERSION}），请升级 Pi Desktop`,
    );
  }
  const now = new Date().toISOString();
  const newId = crypto.randomUUID();
  const newHeader = { ...header, id: newId, timestamp: now, parentSession: header.id };
  const lines = [JSON.stringify(newHeader), ...chain.map((entry) => JSON.stringify(entry))];
  return { newId, lines };
}
