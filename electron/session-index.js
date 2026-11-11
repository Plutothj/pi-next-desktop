// 会话索引（SQLite，Electron 自带 node:sqlite）：
// - `sessions`：元数据（path/cwd/title/mtime/size/changed），列表扫描只 stat + SELECT；
// - `messages_fts`（FTS5）：user/assistant 正文的全文索引，搜索不再全量读 JSONL；
// - `session_views`：每个会话尾部消息的持久缓存（按 mtime/size 版本化），重启后先秒开。
// 文件变了才重新解析并重建该文件的 FTS 行；删除的文件连同索引/缓存一起 prune。
import fs from "node:fs";
import path from "node:path";
import { APP_HOME } from "./app-home.js";
import { logLine } from "./logs.js";
import { scanSessions, sessionMessageTexts, sessionTitle, sessionsRoot } from "./session-files.js";

const DB_FILE = path.join(APP_HOME, "sessions-index.sqlite");
const VIEW_LIMIT = 120;
const VIEW_MAX_BYTES = 3 * 1024 * 1024;

let DatabaseSync = null;
let sqliteChecked = false;
let db = null;
let statements = null;

async function loadSqlite() {
  if (sqliteChecked) return DatabaseSync;
  sqliteChecked = true;
  try {
    const mod = await import("node:sqlite");
    DatabaseSync = mod.DatabaseSync ?? null;
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
}

function openDb() {
  if (db) return db;
  if (!DatabaseSync) return null;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      path TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      mtime REAL NOT NULL,
      size REAL NOT NULL,
      added INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      version INTEGER,
      fts_mtime REAL,
      fts_size REAL
    );
  `);
  // 老库没有 fts_* 列：补上（重复添加会抛，忽略即可）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN fts_mtime REAL");
  } catch {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN fts_size REAL");
  } catch {}
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      path UNINDEXED, role UNINDEXED, text, tokenize = 'unicode61'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_views (
      path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size REAL NOT NULL,
      messages TEXT NOT NULL
    );
  `);
  statements = {
    get: db.prepare("SELECT * FROM sessions WHERE path = ?"),
    upsert: db.prepare(`
      INSERT INTO sessions (path, cwd, title, mtime, size, added, removed, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        cwd = excluded.cwd, title = excluded.title, mtime = excluded.mtime,
        size = excluded.size, added = excluded.added, removed = excluded.removed,
        version = excluded.version
    `),
    setFtsMeta: db.prepare("UPDATE sessions SET fts_mtime = ?, fts_size = ? WHERE path = ?"),
    paths: db.prepare("SELECT path FROM sessions"),
    del: db.prepare("DELETE FROM sessions WHERE path = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM sessions"),
    ftsDel: db.prepare("DELETE FROM messages_fts WHERE path = ?"),
    ftsIns: db.prepare("INSERT INTO messages_fts (path, role, text) VALUES (?, ?, ?)"),
    ftsSearch: db.prepare(`
      SELECT path, snippet(messages_fts, 2, '', '', '…', 24) AS snippet, bm25(messages_fts) AS score
      FROM messages_fts
      WHERE messages_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `),
    viewGet: db.prepare("SELECT messages FROM session_views WHERE path = ?"),
    viewSet: db.prepare(`
      INSERT INTO session_views (path, mtime, size, messages) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime, size = excluded.size, messages = excluded.messages
    `),
    viewDel: db.prepare("DELETE FROM session_views WHERE path = ?"),
  };
  return db;
}

function walk(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(root, dir.name, name);
      try {
        out.push({ file: full, stat: fs.statSync(full) });
      } catch {
        // 扫描时被删：跳过
      }
    }
  }
  return out;
}

function fromRow(row, stat) {
  return {
    path: row.path,
    cwd: row.cwd ?? null,
    title: row.title || "新会话",
    changed: { added: Number(row.added) || 0, removed: Number(row.removed) || 0 },
    mtime: stat.mtimeMs,
    ...(Number(row.version) ? { version: Number(row.version) } : {}),
  };
}

// ---------------------------------------------------------------- 全文索引队列
// 扫描只做元数据；消息解析可能很慢（大文件逐行 JSON.parse），所以放后台按 tick
// 处理。搜索前会先 flush 一小批，保证刚结束的会话能马上被搜到。
const indexQueue = [];
const queuedFiles = new Set();
let scheduled = false;

function runIndex(file) {
  try {
    const stat = fs.statSync(file);
    const entries = sessionMessageTexts(file);
    db.exec("BEGIN");
    try {
      statements.ftsDel.run(file);
      if (entries) {
        for (const entry of entries) statements.ftsIns.run(file, entry.role, ftsText(entry.text));
      }
      // entries=null（文件过大/不可读）也记下 meta，避免每次扫描都重试
      statements.setFtsMeta.run(stat.mtimeMs, stat.size, file);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    logLine("sessions-index", `index ${file}`, err);
  } finally {
    queuedFiles.delete(file);
  }
}

function scheduleIndex() {
  if (scheduled || !indexQueue.length) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    for (let i = 0; i < 2 && indexQueue.length; i++) runIndex(indexQueue.shift());
    scheduleIndex();
  });
}

function queueIndex(file) {
  if (queuedFiles.has(file) || !db) return;
  queuedFiles.add(file);
  indexQueue.push(file);
  scheduleIndex();
}

/** 搜索前等一小批索引落地（最多 max 个文件），剩下的继续后台跑。 */
export function flushSessionIndex(max = 8) {
  if (!db) return 0;
  let processed = 0;
  while (indexQueue.length && processed < max) {
    runIndex(indexQueue.shift());
    processed += 1;
  }
  return indexQueue.length;
}

// ---------------------------------------------------------------- 扫描
/** scanSessions 的索引版：接口与返回值保持一致（按 mtime 倒序）。 */
export async function scanSessionsIndexed(root = sessionsRoot()) {
  const Sqlite = await loadSqlite();
  if (!Sqlite) return scanSessions(root);
  let database = null;
  try {
    database = openDb();
  } catch (err) {
    logLine("sessions-index", err);
    return scanSessions(root);
  }
  if (!database) return scanSessions(root);

  const files = walk(root);
  const out = [];
  const changed = [];
  try {
    for (const { file, stat } of files) {
      const row = statements.get.get(file);
      if (row && row.mtime === stat.mtimeMs && row.size === stat.size) {
        out.push(fromRow(row, stat));
        // 元数据没变但全文索引还没建（老库升级 / 上次中断）→ 补建
        if (row.fts_mtime !== stat.mtimeMs || row.fts_size !== stat.size) queueIndex(file);
        continue;
      }
      const info = sessionTitle(file, stat);
      if (!info) continue;
      changed.push([file, info, stat]);
      out.push({ ...info, mtime: stat.mtimeMs });
    }
    if (changed.length) {
      database.exec("BEGIN");
      try {
        for (const [file, info, stat] of changed) {
          statements.upsert.run(
            file,
            info.cwd ?? null,
            info.title ?? "新会话",
            stat.mtimeMs,
            stat.size,
            info.changed?.added ?? 0,
            info.changed?.removed ?? 0,
            info.version ?? null,
          );
        }
        database.exec("COMMIT");
      } catch (err) {
        database.exec("ROLLBACK");
        throw err;
      }
      for (const [file] of changed) queueIndex(file);
    }
    // prune：表里存在、目录里已经没有的记录（连同全文索引与视图缓存）
    const alive = new Set(files.map((f) => f.file));
    for (const row of statements.paths.all()) {
      if (!alive.has(row.path)) {
        statements.del.run(row.path);
        statements.viewDel.run(row.path);
        statements.ftsDel.run(row.path);
      }
    }
  } catch (err) {
    logLine("sessions-index", err);
    return scanSessions(root);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- 全文搜索
// unicode61 把连续 CJK 当成一个整词，"白屏"搜不到"请排查白屏问题"。索引时在 CJK
// 字符之间插空格让每个字成为 token；查询同样转成短语（"白 屏"），snippet 再还原。
const CJK_CHAR = /[⺀-鿿぀-ヿ가-힯豈-﫿]/;
const CJK_CHAR_G = /[⺀-鿿぀-ヿ가-힯豈-﫿]/g;
const CJK_GAP = /([⺀-鿿぀-ヿ가-힯豈-﫿]) (?=[⺀-鿿぀-ヿ가-힯豈-﫿])/g;

function ftsText(text) {
  return String(text ?? "")
    .replace(CJK_CHAR_G, (ch) => `${ch} `)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSnippet(text) {
  return String(text ?? "").replace(CJK_GAP, "$1").replace(/\s+/g, " ").trim();
}

function sanitizeMatch(query) {
  const tokens = String(query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${ftsText(t).replace(/"/g, '""')}"`).join(" OR ");
}

/** 全文搜索（FTS5）。返回结构与旧的 searchSessions 一致；失败时回退全量扫描。 */
export async function searchSessionsIndexed(query) {
  const Sqlite = await loadSqlite();
  if (!Sqlite) return searchSessionsFallback(query);
  let database = null;
  try {
    database = openDb();
  } catch {
    return searchSessionsFallback(query);
  }
  if (!database) return searchSessionsFallback(query);
  try {
    flushSessionIndex(8);
    const match = sanitizeMatch(query);
    if (!match) return { hits: [], scanned: 0, truncated: false };
    const rows = statements.ftsSearch.all(match, 80);
    const seen = new Set();
    const hits = [];
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      const meta = statements.get.get(row.path);
      hits.push({
        path: row.path,
        title: meta?.title || "新会话",
        cwd: meta?.cwd ?? null,
        mtime: meta?.mtime ?? 0,
        snippet: cleanSnippet(row.snippet),
      });
      if (hits.length >= 30) break;
    }
    const scanned = Number(statements.count.get()?.n ?? 0);
    return { hits, scanned, truncated: rows.length >= 80 || hits.length >= 30 };
  } catch (err) {
    logLine("sessions-index", "search", err);
    return searchSessionsFallback(query);
  }
}

async function searchSessionsFallback(query) {
  const { searchSessions } = await import("./session-files.js");
  return searchSessions(query);
}

// ---------------------------------------------------------------- 视图缓存
function sanitizeMessages(messages) {
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
  return messages.map((m) => {
    const content = Array.isArray(m.content)
      ? m.content.map((b) => {
          if (!b || typeof b !== "object") return b;
          if (b.type === "text" && typeof b.text === "string") {
            return { ...b, text: clip(b.text, 8000) };
          }
          if (b.type === "image") return { ...b, data: "" };
          if (b.type === "toolCall") {
            const args = JSON.stringify(b.arguments ?? {});
            return args.length > 8000 ? { ...b, arguments: {} } : b;
          }
          return b;
        })
      : typeof m.content === "string"
        ? clip(m.content, 8000)
        : m.content;
    const copy = { ...m, content };
    // tool result 的 details 可能非常大（扩展自定义数据），预览不需要
    if ("details" in copy) copy.details = undefined;
    return copy;
  });
}

function inSessionsRoot(file) {
  return path.resolve(file).startsWith(path.resolve(sessionsRoot()) + path.sep);
}

/** 每个会话尾部消息缓存（写穿：pi 每次 get_messages 后由主进程调用）。 */
export function writeSessionView(file, messages) {
  try {
    if (!db || !Array.isArray(messages) || messages.length === 0) return;
    if (!inSessionsRoot(file)) return;
    const stat = fs.statSync(file);
    let tail = sanitizeMessages(messages).slice(-VIEW_LIMIT);
    let json = JSON.stringify(tail);
    while (json.length > VIEW_MAX_BYTES && tail.length > 8) {
      tail = tail.slice(Math.floor(tail.length / 2));
      json = JSON.stringify(tail);
    }
    if (json.length > VIEW_MAX_BYTES) return;
    statements.viewSet.run(file, stat.mtimeMs, stat.size, json);
  } catch (err) {
    logLine("sessions-index", "view write", err);
  }
}

/** 读取持久视图缓存；没有或损坏就返回 null。 */
export function readSessionView(file) {
  try {
    if (!db) return null;
    if (!inSessionsRoot(file)) return null;
    const row = statements.viewGet.get(file);
    if (!row?.messages) return null;
    const messages = JSON.parse(row.messages);
    return Array.isArray(messages) && messages.length ? { messages } : null;
  } catch {
    return null;
  }
}

/** 测试用：关掉连接，模拟下次冷启动。 */
export function closeSessionIndex() {
  try {
    db?.close();
  } catch {}
  db = null;
  statements = null;
}

export const SESSION_INDEX_FILE = DB_FILE;
