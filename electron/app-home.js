// App-private home: ~/.pi-desktop. Keeps the desktop client fully independent
// of the user's own pi install (config, auth, sessions, extensions all live
// here), so this app and the pi CLI can't disturb each other.
//
// pi honours PI_CODING_AGENT_DIR, so pointing it at AGENT_DIR isolates its
// settings/auth/sessions/npm tree. On first run we copy the user's existing
// ~/.pi/agent once (minus the managed runtime, which we ship ourselves).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logLine } from "./logs.js";

export const APP_HOME = process.env.PI_DESKTOP_HOME || path.join(os.homedir(), ".pi-desktop");
export const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(APP_HOME, "agent");

const LEGACY_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

/**
 * Creates ~/.pi-desktop (and agent/) on first run, migrating the user's
 * existing pi config, sessions and extension tree so nothing appears to be
 * lost. Idempotent; the managed runtime (`install/`) is skipped because the
 * packaged app carries its own pi bundle.
 */
export function ensureAppHome() {
  fs.mkdirSync(APP_HOME, { recursive: true });
  if (fs.existsSync(AGENT_DIR)) return { created: false, migrated: false };

  const started = Date.now();
  try {
    if (fs.existsSync(LEGACY_AGENT_DIR)) {
      fs.cpSync(LEGACY_AGENT_DIR, AGENT_DIR, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(LEGACY_AGENT_DIR, src);
          if (!rel) return true;
          return rel.split(path.sep)[0] !== "install";
        },
      });
      logLine(
        "app-home",
        `migrated ${LEGACY_AGENT_DIR} -> ${AGENT_DIR} in ${Date.now() - started}ms`,
      );
      return { created: true, migrated: true };
    }
  } catch (err) {
    logLine("app-home", "migration failed, starting with an empty dir:", err);
  }

  fs.mkdirSync(AGENT_DIR, { recursive: true });
  return { created: true, migrated: false };
}
