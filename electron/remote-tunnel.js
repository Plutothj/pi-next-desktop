import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// 零配置公网入口：用随应用分发的 cloudflared 起一个 Cloudflare Quick Tunnel，
// 把本机 pi-mobile hub（只监听回环）暴露成临时 https://*.trycloudflare.com。
// 手机侧仍然是 pi-mobile 的端到端加密，隧道只转发密文；URL 每次启动都会变。

const PKG_BY_PLATFORM = {
  "win32-x64": "@botharness/cloudflared-win32-x64",
  "darwin-x64": "@botharness/cloudflared-darwin-x64",
  "darwin-arm64": "@botharness/cloudflared-darwin-arm64",
  "linux-x64": "@botharness/cloudflared-linux-x64",
  "linux-arm64": "@botharness/cloudflared-linux-arm64",
};

let child = null;
let currentUrl = null;

export function resolveCloudflared(appRoot) {
  const pkg = PKG_BY_PLATFORM[`${process.platform}-${process.arch}`];
  if (!pkg) return null;
  const binName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [path.join(appRoot, "runtime", "cloudflared", binName)];
  // 打包后 appRoot 是 resources/app.asar；staged runtime 在 resources/runtime。
  if (appRoot.endsWith("app.asar")) {
    candidates.unshift(path.join(path.dirname(appRoot), "runtime", "cloudflared", binName));
  }
  // 开发环境没跑 stage 时的兜底：直接读 optional dependency
  candidates.push(path.join(appRoot, "node_modules", pkg, "bin", binName));
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/** 启动（或复用）quick tunnel；resolve 出公网 https URL。 */
export function startRemoteTunnel({ appRoot, port }) {
  if (child && currentUrl) return Promise.resolve({ ok: true, url: currentUrl });
  const bin = resolveCloudflared(appRoot);
  if (!bin) return Promise.resolve({ ok: false, error: "当前平台没有内置 cloudflared" });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const proc = spawn(
      bin,
      ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child = proc;
    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        currentUrl = match[0];
        finish({ ok: true, url: currentUrl });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      child = null;
      finish({ ok: false, error: err.message });
    });
    proc.on("exit", (code) => {
      child = null;
      currentUrl = null;
      finish({ ok: false, error: `cloudflared exited (${code ?? "?"})` });
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      child = null;
      finish({ ok: false, error: "cloudflared 启动超时（网络不可达？）" });
    }, 25_000);
  });
}

export function stopRemoteTunnel() {
  const proc = child;
  child = null;
  currentUrl = null;
  if (!proc) return { ok: true };
  try {
    proc.kill();
  } catch {}
  return { ok: true };
}

export function remoteTunnelUrl() {
  return currentUrl;
}
