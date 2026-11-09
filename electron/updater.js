// In-app updates via electron-updater + GitHub Releases. Dev builds report
// their mode instead of updating; unsigned macOS builds may fail at
// download/verify — the UI falls back to opening the release page.

import { app, shell } from "electron";
import electronUpdater from "electron-updater";
import { logLine } from "./logs.js";

// electron-updater is CJS; the named export isn't visible to ESM.
const { autoUpdater } = electronUpdater;

export const RELEASES_URL = "https://github.com/Plutothj/pi-next-desktop/releases/latest";

const compareVersions = (a, b) => {
  const pa = String(a ?? "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
};

export function registerUpdater({ safeHandle, send }) {
  let state = {
    status: "idle", // idle | checking | up-to-date | available | downloading | ready | error | dev
    version: null,
    percent: 0,
    error: null,
    current: app.getVersion(),
  };
  const setState = (patch) => {
    state = { ...state, ...patch };
    send({ type: "update_status", update: state });
  };

  if (!app.isPackaged) {
    // electron-updater needs a packaged app + app-update.yml; in dev the UI
    // shows current version only.
    state = { ...state, status: "dev" };
    safeHandle("update:state", async () => state);
    safeHandle("update:check", async () => ({ ok: true, ...state }));
    safeHandle("update:download", async () => ({ ok: false, ...state, error: "开发模式不支持更新" }));
    safeHandle("update:install", async () => ({ ok: false, error: "开发模式不支持更新" }));
    safeHandle("update:releases", async () => ({ ok: true }));
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setState({ status: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setState({ status: "available", version: info.version, error: null }),
  );
  autoUpdater.on("update-not-available", (info) =>
    setState({ status: "up-to-date", version: info.version }),
  );
  autoUpdater.on("download-progress", (progress) =>
    setState({ status: "downloading", percent: Math.round(progress.percent ?? 0) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({ status: "ready", version: info.version, percent: 100 }),
  );
  autoUpdater.on("error", (err) => {
    logLine("updater", err);
    setState({ status: "error", error: err?.message ?? String(err) });
  });

  safeHandle("update:state", async () => state);

  safeHandle("update:check", async () => {
    try {
      setState({ status: "checking", error: null });
      const res = await autoUpdater.checkForUpdates();
      const latest = res?.updateInfo?.version ?? null;
      const available =
        res?.isUpdateAvailable ?? (latest ? compareVersions(latest, app.getVersion()) > 0 : false);
      if (!available) setState({ status: "up-to-date", version: latest ?? app.getVersion() });
      return { ok: true, ...state };
    } catch (err) {
      logLine("updater", err);
      setState({ status: "error", error: err?.message ?? String(err) });
      return { ok: false, ...state };
    }
  });

  safeHandle("update:download", async () => {
    // GitHub Releases 的 CDN 会间歇 504；先自动退避重试几次，再让用户手动开
    // 发布页下载。
    const delays = [0, 2000, 5000, 10_000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) {
        setState({ status: "downloading", percent: 0, error: null });
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
      try {
        await autoUpdater.downloadUpdate();
        return { ok: true, ...state };
      } catch (err) {
        lastError = err;
        logLine("updater", `download attempt ${attempt + 1} failed: ${err?.message ?? err}`);
      }
    }
    const message = lastError?.message ?? String(lastError ?? "下载失败");
    setState({
      status: "error",
      error: /504|502|503|Gateway Time-out/i.test(message)
        ? `${message}（GitHub Releases 暂时不可用，可点「查看发布页」手动下载）`
        : message,
    });
    return { ok: false, ...state };
  });

  safeHandle("update:install", async () => {
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  safeHandle("update:releases", async () => {
    shell.openExternal(RELEASES_URL);
    return { ok: true };
  });
}
