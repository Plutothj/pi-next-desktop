// Projects: manually opened folders persist even before they have any
// sessions; session cwds are merged in as implicit projects.

import fs from "node:fs";
import path from "node:path";
import { safeHandle } from "./ipc.js";
import { logLine } from "./logs.js";

export function registerProjectHandlers({ userDataDir, scanSessions }) {
  const projectsFile = path.join(userDataDir, "projects.json");

  const readProjects = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
      return Array.isArray(raw?.projects)
        ? raw.projects.filter((p) => typeof p === "string")
        : [];
    } catch {
      return [];
    }
  };

  const writeProjects = (projects) => {
    try {
      fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
      fs.writeFileSync(projectsFile, JSON.stringify({ projects }, null, 2));
    } catch (err) {
      logLine("projects", err);
    }
  };

  safeHandle("projects:list", () => {
    const byPath = new Map();
    for (const session of scanSessions()) {
      const entry = byPath.get(session.cwd) ?? { path: session.cwd, sessions: 0, mtime: 0, stored: false };
      entry.sessions += 1;
      entry.mtime = Math.max(entry.mtime, session.mtime);
      byPath.set(session.cwd, entry);
    }
    for (const projectPath of readProjects()) {
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
      const stored = readProjects();
      if (!stored.includes(dir)) writeProjects([dir, ...stored].slice(0, 50));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("projects:remove", (_e, dir) => {
    writeProjects(readProjects().filter((p) => p !== dir));
    return { ok: true };
  });
}
