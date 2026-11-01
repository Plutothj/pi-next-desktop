// IPC handlers for the usage dashboard (aggregated from session files).

import { safeHandle } from "./ipc.js";
import { aggregateUsage } from "./usage.js";

export function registerUsageHandlers() {
  safeHandle("stats:usage", async (_e, { days } = {}) => {
    const range = days === 7 || days === 30 ? days : "all";
    return aggregateUsage(range);
  });
}
