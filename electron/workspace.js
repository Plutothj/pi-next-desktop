// Workspace inspection used by the side panels: file search/tree/read,
// subagent profiles, and SSH hosts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "./config.js";
import { safeHandle } from "./ipc.js";

// Bounded walk for @-mentions: enough for autocomplete, cheap on big repos.
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "release", ".venv", "__pycache__"]);

function listFiles(root, limit = 4000) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(full, depth + 1);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root, 0);
  return out;
}

// pi-subagents ships profiles in its package; projects add their own.
function agentDirs(cwd) {
  return [
    path.join(config.AGENT_DIR, "npm", "node_modules", "pi-subagents", "agents"),
    path.join(cwd ?? os.homedir(), ".pi", "agents"),
  ];
}

const resolveRoot = (cwd) => (cwd && fs.existsSync(cwd) ? cwd : os.homedir());

export function registerWorkspaceHandlers() {
  safeHandle("files:search", (_e, { cwd, query } = {}) => {
    const root = resolveRoot(cwd);
    const files = listFiles(root);
    const q = (query ?? "").toLowerCase();
    const scored = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      const idx = q ? lower.indexOf(q) : 0;
      if (idx === -1) continue;
      const base = lower.slice(Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1);
      scored.push({ file, score: (base.startsWith(q) ? 0 : 100) + idx });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 40).map((s) => s.file);
  });

  safeHandle("files:tree", (_e, { cwd, dir = "" } = {}) => {
    const root = resolveRoot(cwd);
    const target = path.resolve(root, dir);
    if (!target.startsWith(root)) return [];
    let entries = [];
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return []; }
    return entries
      // The tree shows dotfiles like ZCode (.git, .github, .zcode, …); only
      // heavy build dirs and node_modules stay hidden.
      .filter((e) => e.name === ".git" || !SKIP.has(e.name))
      .map((e) => ({ name: e.name, path: path.posix.join(dir, e.name), dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, 500);
  });

  // Preview only: refuse anything outside the workspace or over 1 MB.
  safeHandle("files:read", (_e, { cwd, file } = {}) => {
    const root = resolveRoot(cwd);
    if (typeof file !== "string" || !file) return { error: "缺少文件路径" };
    const target = path.resolve(root, file);
    if (!target.startsWith(root)) return { error: "越界路径" };
    try {
      const stat = fs.statSync(target);
      if (stat.size > 1_000_000) return { error: "文件过大" };
      return { content: fs.readFileSync(target, "utf8"), size: stat.size };
    } catch (err) {
      return { error: err.message };
    }
  });

  safeHandle("agents:list", (_e, { cwd } = {}) => {
    const out = [];
    for (const [i, dir] of agentDirs(cwd).entries()) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const name of files) {
        if (!name.endsWith(".md")) continue;
        const full = path.join(dir, name);
        let raw = "";
        try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
        const front = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
        const field = (key) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
        out.push({
          name: name.replace(/\.md$/, ""),
          path: full,
          scope: i === 0 ? "builtin" : "project",
          description: field("description") ?? "",
          tools: field("tools") ?? "",
          model: field("model") ?? "",
        });
      }
    }
    return out;
  });

  // Project-level plan documents (like ZCode's .zcode/plans): dual-model
  // planning writes the approved plan here so execution can read it back.
  safeHandle("plans:save", (_e, { cwd, content } = {}) => {
    const root = resolveRoot(cwd);
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "方案内容为空" };
    }
    if (content.length > 1_000_000) return { ok: false, error: "方案过大" };
    const dir = path.join(root, ".pi", "plans");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `plan-${stamp}.md`);
    fs.writeFileSync(file, `${content.trim()}\n`);
    return { ok: true, path: file };
  });

  safeHandle("ssh:hosts", () => {
    const file = path.join(os.homedir(), ".ssh", "config");
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
    const hosts = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*Host\s+(.+)$/i);
      if (!match) continue;
      for (const host of match[1].split(/\s+/)) {
        if (host && !host.includes("*") && !host.startsWith("!")) hosts.push(host);
      }
    }
    return [...new Set(hosts)];
  });
}
