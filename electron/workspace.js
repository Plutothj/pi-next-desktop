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
    // + path.sep：/foo/bar-evil/x 不能因前缀相同而通过 /foo/bar 的守卫
    if (target !== root && !target.startsWith(root + path.sep)) return { error: "越界路径" };
    try {
      const stat = fs.statSync(target);
      if (stat.size > 1_000_000) return { error: "文件过大" };
      return { content: fs.readFileSync(target, "utf8"), size: stat.size };
    } catch (err) {
      return { error: err.message };
    }
  });

  // docx 预览：mammoth 转 HTML（保留标题/列表/表格结构，图片转 base64 内联）。
  safeHandle("files:readDoc", async (_e, { cwd, file } = {}) => {
    const root = resolveRoot(cwd);
    if (typeof file !== "string" || !file) return { ok: false, error: "缺少文件路径" };
    if (!file.toLowerCase().endsWith(".docx")) return { ok: false, error: "仅支持 .docx" };
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, error: "越界路径" };
    try {
      const stat = fs.statSync(target);
      if (stat.size > 20_000_000) return { ok: false, error: "文件超过 20MB" };
      const mammoth = (await import("mammoth")).default;
      const { value: html } = await mammoth.convertToHtml({ buffer: fs.readFileSync(target) });
      return { ok: true, html };
    } catch (err) {
      return { ok: false, error: `文档解析失败: ${err.message}` };
    }
  });

  // pdf 预览：字节直接给渲染层的 pdf.js（渲染比文本提取保真）。
  safeHandle("files:readPdf", (_e, { cwd, file } = {}) => {
    const root = resolveRoot(cwd);
    if (typeof file !== "string" || !file) return { ok: false, error: "缺少文件路径" };
    if (!file.toLowerCase().endsWith(".pdf")) return { ok: false, error: "仅支持 .pdf" };
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, error: "越界路径" };
    try {
      const stat = fs.statSync(target);
      if (stat.size > 50_000_000) return { ok: false, error: "文件超过 50MB" };
      return { ok: true, data: new Uint8Array(fs.readFileSync(target)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 表格预览：xlsx/xls 结构化解析（SheetJS）→ sheet × 行列，供渲染层画网格。
  // csv/tsv 走 files:read 的文本路径（现有 DelimitedTable），不在此列。
  const TABLE_EXT = new Set(["xlsx", "xls"]);
  const TABLE_LIMITS = { sheets: 30, rows: 2000, cols: 80, bytes: 20_000_000 };
  safeHandle("files:readTable", async (_e, { cwd, file } = {}) => {
    const root = resolveRoot(cwd);
    if (typeof file !== "string" || !file) return { ok: false, error: "缺少文件路径" };
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    if (!TABLE_EXT.has(ext)) return { ok: false, error: `不支持的表格类型: .${ext}` };
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, error: "越界路径" };
    try {
      const stat = fs.statSync(target);
      if (stat.size > TABLE_LIMITS.bytes) return { ok: false, error: "文件超过 20MB" };
      const XLSX = await import("xlsx");
      const wb = XLSX.read(fs.readFileSync(target), { type: "buffer" });
      const sheets = [];
      for (const name of wb.SheetNames.slice(0, TABLE_LIMITS.sheets)) {
        const sheet = wb.Sheets[name];
        // raw:false → 按显示格式取值（日期/百分比不再是原始数）
        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
        const rows = aoa.slice(0, TABLE_LIMITS.rows).map((row) =>
          row.slice(0, TABLE_LIMITS.cols).map((cell) => (cell == null ? "" : String(cell))),
        );
        sheets.push({ name, rows, truncatedRows: aoa.length > TABLE_LIMITS.rows });
      }
      return {
        ok: true,
        sheets,
        truncatedSheets: wb.SheetNames.length > TABLE_LIMITS.sheets,
      };
    } catch (err) {
      return { ok: false, error: `表格解析失败: ${err.message}` };
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

  // 计划工作台：列出/读取/删除 <项目>/.pi/plans/*.md
  const plansDir = (cwd) => path.join(resolveRoot(cwd), ".pi", "plans");
  const planGuard = (file, cwd) => {
    const resolved = path.resolve(file);
    const root = path.resolve(plansDir(cwd)) + path.sep;
    if (!resolved.startsWith(root)) throw new Error("路径不在 plans 目录内");
    return resolved;
  };

  safeHandle("plans:list", (_e, { cwd } = {}) => {
    try {
      const dir = plansDir(cwd);
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          return { path: full, name: f.replace(/\.md$/, ""), mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  });

  safeHandle("plans:read", (_e, { cwd, file } = {}) => {
    try {
      const full = planGuard(file, cwd);
      const stat = fs.statSync(full);
      if (stat.size > 1_000_000) return { ok: false, error: "文件过大" };
      return { ok: true, content: fs.readFileSync(full, "utf8") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("plans:delete", (_e, { cwd, file } = {}) => {
    try {
      fs.rmSync(planGuard(file, cwd), { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
