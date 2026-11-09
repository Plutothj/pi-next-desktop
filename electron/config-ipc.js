// Settings handlers backed by config.js. Edits only take effect in a freshly
// started pi, so mutating handlers ask the renderer to restart it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { net } from "electron";
import * as config from "./config.js";
import { safeHandle } from "./ipc.js";
import { requireObject } from "./ipc-helpers.js";
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
        // 与 RPC 子进程一致：安装必须落到隔离的 agent 目录，
        // 否则 pi 会写进默认的 ~/.pi/agent，而已安装列表读的是 AGENT_DIR。
        PI_CODING_AGENT_DIR: config.AGENT_DIR,
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

  // 自定义命令（prompts .md）：保存/删除后重启 pi 注册 /命令
  safeHandle("cfg:savePrompt", (_e, payload) => {
    try {
      config.savePrompt(requireObject(payload, "payload"));
      return afterChange();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:deletePrompt", (_e, payload) => {
    try {
      config.deletePrompt(requireObject(payload, "payload"));
      return afterChange();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  safeHandle("cfg:readPrompt", (_e, payload) => config.readPrompt(requireObject(payload, "payload")));

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

  // 从供应商 /models 端点拉取可勾选的模型列表；密钥留空时回退已存密钥。
  // 预期内的失败（密钥错误、网络不通）返回 {ok:false}，不打错误日志。
  safeHandle("cfg:fetchModels", async (_e, payload) => {
    try {
      const models = await config.fetchProviderModels(requireObject(payload, "payload"));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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

  safeHandle("cfg:gallery", async (_e, payload) => {
    const { query = "", from = 0 } = requireObject(payload ?? {}, "payload");
    return config
      .searchGallery({
        query,
        from,
        // electron net 走 Chromium 网络栈，自动继承系统代理/证书设置；
        // Node 的 fetch 不认系统代理，用户开 7890 时会拿到 HTML 拦截页。
        fetcher: (url, init) => net.fetch(url, init),
      })
      .then((r) => ({ ok: true, ...r }))
      .catch((err) => ({ ok: false, error: err.message }));
  });

  safeHandle("cfg:readSkill", (_e, { file, cwd } = {}) => {
    if (typeof file !== "string" || !file) throw new Error("缺少文件路径");
    // Skills live under the agent dir, the shared ~/.agents/skills, or the project's .pi.
    const allowed = [
      config.AGENT_DIR,
      ...config.USER_SKILL_ROOTS,
      ...(typeof cwd === "string" && cwd ? [path.join(cwd, ".pi")] : []),
    ];
    const resolved = path.resolve(file);
    const ok = allowed.some((root) => resolved.startsWith(path.resolve(root) + path.sep));
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
