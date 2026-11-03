// 内置扩展：随安装包分发的 tgz，首次启动用 pi 自己的安装器离线安装到
// ~/.pi-desktop/agent（依赖树交给 pi/npm 解析，比手工拷贝 node_modules 可靠）。
// 版本跟随应用：应用升级后重新校验一次，缺失或版本标记过期就重装。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logLine } from "./logs.js";

const MARKER = "bundled-extensions.json";

export function bundledExtensionsDir(resourcesPath) {
  const dir = path.join(resourcesPath ?? "", "bundled-extensions");
  return fs.existsSync(dir) ? dir : null;
}

const readMarker = (agentDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentDir, MARKER), "utf8"));
  } catch {
    return null;
  }
};

const writeMarker = (agentDir, data) => {
  try {
    fs.writeFileSync(path.join(agentDir, MARKER), `${JSON.stringify(data, null, 2)}\n`);
  } catch {}
};

/** 已安装的包源列表（settings.packages 的规范化形式）。 */
const installedSources = (agentDir) => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    return new Set(
      (settings.packages ?? []).map((p) => (typeof p === "string" ? p : p?.source)).filter(Boolean),
    );
  } catch {
    return new Set();
  }
};

function runPi(runtime, args, env) {
  return new Promise((resolve) => {
    const proc = spawn(runtime.node, [runtime.cli, ...args], {
      env: { ...process.env, ...runtime.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      out += d.toString();
    });
    proc.on("error", (err) => resolve({ ok: false, error: err.message, log: out }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, log: out }));
  });
}

/** 把内置扩展的相对路径条目改写为绝对路径（bundle 目录是稳定位置）。 */
function rewriteToAbsolute(agentDir, bundleDir) {
  try {
    const file = path.join(agentDir, "settings.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(settings.packages)) return;
    settings.packages = settings.packages.map((entry) => {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string") return entry;
      const base = source.split(/[\\/]/).pop();
      const abs = path.join(bundleDir, base);
      if (!fs.existsSync(abs)) return entry;
      return typeof entry === "string" ? abs : { ...entry, source: abs };
    });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    logLine("bundled-ext", "改写绝对路径失败:", err);
  }
}

/**
 * 首次启动（或应用版本变化后）把内置扩展装进 agent 目录。
 * 幂等：已装且标记版本一致时直接跳过。失败只记日志，不阻塞启动。
 */
export async function installBundledExtensions({ resourcesPath, agentDir, runtime, appVersion }) {
  const dir = bundledExtensionsDir(resourcesPath);
  if (!dir || !runtime) return { ok: false, reason: "no-bundle" };

  const entries = fs.readdirSync(dir);
  const bundles = entries.filter((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isDirectory();
    } catch {
      return false;
    }
  });
  if (bundles.length === 0) return { ok: false, reason: "empty-bundle" };

  const marker = readMarker(agentDir);
  const installed = installedSources(agentDir);
  // pi 把本地包记成相对路径（如 "..\\resources\\bundled-extensions\\pi-memory"），
  // 所以按目录名的尾巴匹配，而不是拼绝对路径。
  const knownSource = (name) => [...installed].some((s) => s.includes(name));

  const pending = bundles.filter((f) => {
    // 标记里记着这个版本已处理过 → 跳过（用户可能主动卸载了，尊重其选择）
    if (marker?.version === appVersion && marker?.handled?.includes(f)) return false;
    return !knownSource(f);
  });

  if (pending.length === 0) {
    writeMarker(agentDir, { version: appVersion, handled: bundles });
    return { ok: true, installed: [] };
  }

  const done = [];
  for (const file of pending) {
    const abs = path.join(dir, file);
    const res = await runPi(runtime, ["install", abs], {
      PI_CODING_AGENT_DIR: agentDir,
    });
    if (res.ok) {
      done.push(file);
      logLine("bundled-ext", `已安装内置扩展 ${file}`);
    } else {
      logLine("bundled-ext", `安装失败 ${file}: ${(res.log ?? res.error ?? "").slice(-300)}`);
    }
  }

  // pi 会把本地安装记成相对 agent 目录的路径；改写为绝对路径，
  // 这样换安装目录/重装后仍能解析（否则 .\..\Programs\... 会断）。
  if (done.length) rewriteToAbsolute(agentDir, dir);

  writeMarker(agentDir, {
    version: appVersion,
    handled: [...new Set([...(marker?.handled ?? []), ...bundles])],
  });
  return { ok: done.length > 0, installed: done };
}
