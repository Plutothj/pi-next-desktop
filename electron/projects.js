// Projects: manually opened folders persist even before they have any
// sessions; session cwds are merged in as implicit projects.

import fs from "node:fs";
import path from "node:path";
import { safeHandle } from "./ipc.js";
import { logLine } from "./logs.js";

export function registerProjectHandlers({ userDataDir, scanSessions }) {
  const projectsFile = path.join(userDataDir, "projects.json");

  const readStore = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
      return {
        projects: Array.isArray(raw?.projects) ? raw.projects.filter((p) => typeof p === "string") : [],
        removed: Array.isArray(raw?.removed) ? raw.removed.filter((p) => typeof p === "string") : [],
      };
    } catch {
      return { projects: [], removed: [] };
    }
  };

  const writeStore = (store) => {
    try {
      fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
      fs.writeFileSync(projectsFile, JSON.stringify(store, null, 2));
    } catch (err) {
      logLine("projects", err);
    }
  };

  const readProjects = () => readStore().projects;

  safeHandle("projects:list", () => {
    const store = readStore();
    const removed = new Set(store.removed);
    const byPath = new Map();
    for (const session of scanSessions()) {
      if (removed.has(session.cwd)) continue; // 用户已移除：不再作为隐式项目出现
      const entry = byPath.get(session.cwd) ?? { path: session.cwd, sessions: 0, mtime: 0, stored: false };
      entry.sessions += 1;
      entry.mtime = Math.max(entry.mtime, session.mtime);
      byPath.set(session.cwd, entry);
    }
    for (const projectPath of store.projects) {
      const entry = byPath.get(projectPath) ?? { path: projectPath, sessions: 0, mtime: 0, stored: false };
      entry.stored = true;
      byPath.set(projectPath, entry);
    }
    return [...byPath.values()]
      .map((p) => ({
        ...p,
        name: path.basename(p.path) || p.path,
        exists: fs.existsSync(p.path),
      }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  });

  safeHandle("projects:add", (_e, dir) => {
    try {
      if (typeof dir !== "string" || !fs.statSync(dir).isDirectory()) {
        return { ok: false, error: "目录不存在" };
      }
      const store = readStore();
      if (!store.projects.includes(dir)) store.projects.unshift(dir);
      // 重新添加：从 removed 里清除
      store.removed = store.removed.filter((p) => p !== dir);
      store.projects = store.projects.slice(0, 50);
      writeStore(store);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("projects:remove", (_e, dir) => {
    const store = readStore();
    store.projects = store.projects.filter((p) => p !== dir);
    // 记入 removed：有会话的目录不再作为隐式项目冒出来
    if (!store.removed.includes(dir)) store.removed.push(dir);
    writeStore(store);
    return { ok: true };
  });
}
