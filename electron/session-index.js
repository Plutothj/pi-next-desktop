// 会话元数据索引：用 SQLite（Electron 45 自带的 Node 22 `node:sqlite`）持久化
// `path/cwd/title/mtime/size/changed`。扫描时只 stat 文件，没变的行直接查表，
// 不再重读 JSONL；冷启动从"读整个 sessions 目录"降到"每条一次 stat + 一条 SELECT"。
// 纯增量：文件变了才重新解析并 upsert；删除的文件顺手 prune。
import fs from "node:fs";
import path from "node:path";
import { APP_HOME } from "./app-home.js";
import { logLine } from "./logs.js";
import { scanSessions, sessionTitle, sessionsRoot } from "./session-files.js";

const DB_FILE = path.join(APP_HOME, "sessions-index.sqlite");
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      path TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      mtime REAL NOT NULL,
      size REAL NOT NULL,
      added INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      version INTEGER
    );
  `);
  db.exec("PRAGMA journal_mode = WAL");
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
    paths: db.prepare("SELECT path FROM sessions"),
    del: db.prepare("DELETE FROM sessions WHERE path = ?"),
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
        // 文件在扫描时被删掉：跳过
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
    }
    // prune：表里存在、目录里已经没有的记录
    const alive = new Set(files.map((f) => f.file));
    for (const row of statements.paths.all()) {
      if (!alive.has(row.path)) statements.del.run(row.path);
    }
  } catch (err) {
    logLine("sessions-index", err);
    return scanSessions(root);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
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
