// Settings handlers backed by config.js. Edits only take effect in a freshly
// started pi, so mutating handlers ask the renderer to restart it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import { safeHandle } from "./ipc.js";
import { resolveRuntime } from "./pi-process.js";

const afterChange = () => ({ ok: true, restart: true });

// `pi install` shelling out: pi's own resolver owns the npm tree, so don't
// reimplement it. Output is streamed so the UI can show progress.
function runPi(args, send) {
  const rt = resolveRuntime();
  return new Promise((resolve) => {
    const proc = spawn(rt.node, [rt.cli, ...args], {
      env: {
        ...process.env,
        ...rt.env,
        PATH: [path.dirname(rt.node), process.env.PATH ?? ""].join(path.delimiter),
        ...(rt.installRoot ? { PI_MANAGED_INSTALL_ROOT: rt.installRoot } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const onData = (d) => {
      const text = d.toString();
      log += text;
      send({ type: "cfg_progress", line: text.trimEnd() });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => resolve({ ok: false, error: err.message, log }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, log }));
  });
}

export function registerConfigHandlers({ send }) {
  safeHandle("cfg:read", (_e, { cwd } = {}) => ({
    settings: config.readSettings(),
    providers: config.listProviders(),
    packages: config.listPackages(),
    skills: config.listSkills(cwd),
    mcp: config.listMcp(),
    prompts: config.listPrompts(cwd),
    memory: config.listMemory(),
    persona: config.readPersona(cwd),
    apiKinds: config.API_KINDS,
    agentDir: config.AGENT_DIR,
  }));

  safeHandle("cfg:setMcp", (_e, { name, enabled } = {}) => {
    try {
      return config.setMcpEnabled(name, enabled);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:savePersona", (_e, payload) => {
    try {
      return config.writePersona(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:saveProvider", (_e, payload) => {
    try {
      config.saveProvider(payload);
      return afterChange();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:deleteProvider", (_e, name) => {
    config.deleteProvider(name);
    return afterChange();
  });

  safeHandle("cfg:setSetting", (_e, patch) => {
    // A bare string here used to spread into per-character keys and wreck settings.json.
    if (typeof patch !== "object" || patch === null) throw new Error("cfg:setSetting 需要一个 { key: value } 对象");
    const settings = config.readSettings();
    for (const [key, value] of Object.entries(patch ?? {})) {
      const parts = key.split(".");
      let node = settings;
      for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
        node = node[part];
      }
      const last = parts.at(-1);
      if (value === null || value === undefined) delete node[last];
      else node[last] = value;
    }
    config.writeSettings(settings);
    return { ok: true, restart: true };
  });

  safeHandle("cfg:gallery", (_e, query) => config.searchGallery(query).catch((err) => ({ error: err.message })));

  safeHandle("cfg:readSkill", (_e, { file, cwd } = {}) => {
    if (typeof file !== "string" || !file) throw new Error("缺少文件路径");
    // Skills live under the agent dir or the project's .pi; refuse anything else.
    const allowed = [config.AGENT_DIR, ...(typeof cwd === "string" && cwd ? [path.join(cwd, ".pi")] : [])];
    const resolved = path.resolve(file);
    const ok = allowed.some((root) => resolved.startsWith(root + path.sep));
    if (!ok) throw new Error("路径不在技能目录内");
    const stat = fs.statSync(resolved);
    if (stat.size > 1_000_000) throw new Error("文件过大");
    return fs.readFileSync(resolved, "utf8");
  });

  safeHandle("cfg:deleteSkill", (_e, dir) => {
    try {
      config.deleteSkill(dir);
      return afterChange();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:setResources", (_e, { source, disabled } = {}) => {
    config.setPackageResources(source, disabled);
    return afterChange();
  });

  safeHandle("cfg:install", async (_e, source) => {
    const res = await runPi(["install", source], send);
    return { ...res, ...afterChange() };
  });

  safeHandle("cfg:uninstall", async (_e, source) => {
    const res = await runPi(["remove", source], send);
    if (!res.ok) config.removePackageEntry(source);
    return { ...res, ...afterChange() };
  });
}
