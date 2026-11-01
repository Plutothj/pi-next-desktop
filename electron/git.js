// Git branch info, read straight from git (no pi extension required).
// GIT_TERMINAL_PROMPT=0 keeps a credential prompt from hanging the child.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeHandle } from "./ipc.js";

function git(dir, args) {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
  });
}

const gitDir = (cwd) => (cwd && fs.existsSync(cwd) ? cwd : os.homedir());

export function registerGitHandlers() {
  safeHandle("git:status", async (_e, { cwd } = {}) => {
    const res = await git(gitDir(cwd), ["status", "--porcelain=v2", "--branch"]);
    if (!res.ok) return { isRepo: false, error: res.error ?? res.stderr?.trim() };
    const lines = res.stdout.split("\n");
    const head = lines.find((l) => l.startsWith("# branch.head "))?.slice("# branch.head ".length) ?? "";
    const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length) ?? "";
    // "# branch.ab +2 -1" (absent when there is no upstream)
    const ab = lines.find((l) => l.startsWith("# branch.ab ")) ?? "";
    const ahead = Number(ab.match(/\+(\d+)/)?.[1] ?? 0);
    const behind = Number(ab.match(/-(\d+)/)?.[1] ?? 0);
    const detached = head === "(detached)";
    // Entries (1/2/u = changed, ? = untracked) mean a dirty tree; headers start with #.
    const dirty = lines.some((l) => /^[12u?]\s/.test(l));

    // Per-file status for the file tree: cwd-relative paths, "/" separated.
    let changes = [];
    const [porcelain, toplevel] = await Promise.all([
      git(gitDir(cwd), ["status", "--porcelain", "-z"]),
      git(gitDir(cwd), ["rev-parse", "--show-toplevel"]),
    ]);
    if (porcelain.ok && toplevel.ok) {
      const root = toplevel.stdout.trim();
      const base = path.resolve(gitDir(cwd));
      const tokens = porcelain.stdout.split("\0");
      let i = 0;
      while (i < tokens.length) {
        const entry = tokens[i++];
        if (!entry) continue;
        const status = entry.slice(0, 2);
        const paths = [entry.slice(3)];
        // Rename/copy entries carry a second path token.
        if (status[0] === "R" || status[0] === "C") {
          const original = tokens[i];
          if (original) {
            paths.push(original);
            i += 1;
          }
        }
        for (const file of paths) {
          const abs = path.resolve(root, file);
          if (abs !== base && !abs.startsWith(base + path.sep)) continue;
          changes.push({
            path: path.relative(base, abs).split(path.sep).join("/"),
            untracked: status === "??",
          });
        }
        if (changes.length >= 500) break;
      }
    }

    return {
      isRepo: true,
      branch: detached ? oid.slice(0, 7) || "detached" : head,
      detached,
      ahead,
      behind,
      dirty,
      changes,
    };
  });

  safeHandle("git:branches", async (_e, { cwd } = {}) => {
    const res = await git(gitDir(cwd), [
      "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads",
    ]);
    if (!res.ok) return { branches: [], error: res.stderr?.trim() };
    return { branches: res.stdout.split("\n").map((s) => s.trim()).filter(Boolean) };
  });

  safeHandle("git:checkout", async (_e, { cwd, branch } = {}) => {
    if (typeof branch !== "string" || !branch.trim()) return { ok: false, error: "无效的分支名" };
    const dir = gitDir(cwd);
    // `switch` is clearer but only exists in git >= 2.23; fall back to checkout.
    let res = await git(dir, ["switch", branch]);
    if (!res.ok) res = await git(dir, ["checkout", branch]);
    return res.ok ? { ok: true } : { ok: false, error: (res.stderr || res.error || `退出码 ${res.code}`).trim() };
  });
}
