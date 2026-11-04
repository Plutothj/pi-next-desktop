import fs from "node:fs";
import path from "node:path";
import { APP_HOME } from "./app-home.js";
import { approvePreviewFile } from "./workspace.js";

// 附件落盘 + 会话内索引。
//
// 为什么落盘：附件发送时只被读成文本内联进 prompt，原件不留在任何地方——
// 用户之后想在预览面板重新打开那张表就没了。落盘后聊天里的附件 chip 可以
// 直接点开预览（走 files:readTable/readDoc/readPdf 的 abs 白名单）。
//
// 索引按 (cwd, ts) 记账而不是 sessionFile：新会话在第一条消息前还没有文件
// 路径，按会话键会漏记录。

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RECORDS = 500;

const attachmentsRoot = () => path.join(APP_HOME, "attachments");
const indexFile = () => path.join(attachmentsRoot(), "index.json");

const sanitize = (name) =>
  (name || "attachment")
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120) || "attachment";

function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
  }
}

function writeIndex(records) {
  fs.mkdirSync(attachmentsRoot(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify({ records: records.slice(-MAX_RECORDS) }, null, 2));
}

export function saveAttachment({ name, dataBase64 } = {}) {
  if (typeof dataBase64 !== "string" || !dataBase64) return { ok: false, error: "缺少附件数据" };
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length > MAX_BYTES) return { ok: false, error: "附件超过 20MB" };
  try {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const dir = path.join(attachmentsRoot(), month);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const safe = sanitize(name);
    const ext = path.extname(safe);
    const base = ext ? safe.slice(0, -ext.length) : safe;
    const file = path.join(dir, `${stamp}-${rand}-${base}${ext}`);
    fs.writeFileSync(file, bytes);
    // 登记进预览白名单，聊天 chip 点开即可读
    approvePreviewFile(file);
    return { ok: true, path: file, name: safe, size: bytes.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function recordMessageAttachments({ cwd, ts, files } = {}) {
  if (!Array.isArray(files) || files.length === 0) return { ok: true };
  const records = readIndex();
  records.push({
    cwd: typeof cwd === "string" ? cwd : "",
    ts: typeof ts === "number" ? ts : Date.now(),
    files: files
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({ name: String(f.name ?? path.basename(f.path)), path: f.path, kind: String(f.kind ?? "") })),
  });
  try {
    writeIndex(records);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function listMessageAttachments({ cwd } = {}) {
  const records = readIndex();
  const wanted = typeof cwd === "string" && cwd ? cwd : null;
  return records
    .filter((r) => (wanted ? r.cwd === wanted : true))
    .filter((r) => r.files?.every((f) => fs.existsSync(f.path)))
    .map((r) => ({ ts: r.ts, files: r.files }));
}
