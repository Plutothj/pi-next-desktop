import { useCallback, useEffect, useState } from "react";
import type { UpdateState } from "@/lib/pi";

/**
 * In-app updates: state comes from the initial query plus live
 * `update_status` events pushed by the main process.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    status: "idle",
    version: null,
    percent: 0,
    error: null,
    current: "",
  });

  useEffect(() => {
    window.pi.updater.state().then(setState).catch(() => {});
    return window.pi.onEvent((rec) => {
      if (rec.type === "update_status" && rec.update) {
        setState((prev) => ({ ...prev, ...rec.update }));
      }
    });
  }, []);

  const check = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "checking" }));
    const res = await window.pi.updater.check().catch(() => null);
    if (res) setState((prev) => ({ ...prev, ...res }));
    return res;
  }, []);

  const download = useCallback(async () => {
    return window.pi.updater.download().catch(() => null);
  }, []);

  const install = useCallback(() => window.pi.updater.install(), []);
  const openReleases = useCallback(() => window.pi.updater.openReleases(), []);

  return { state, check, download, install, openReleases };
}
