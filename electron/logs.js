// Pure log ring: no Electron imports, so it is unit-testable and usable from
// any module. diag.js wires this into the export handler.

const MAX_LOG_LINES = 500;
const recent = [];

const fmt = (parts) =>
  parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : String(part)))
    .join(" ");

/** Adds a line to the diagnostic ring without writing to stderr. */
export function recordLine(scope, ...parts) {
  recent.push(`[${new Date().toISOString()}] [${scope}] ${fmt(parts)}`);
  if (recent.length > MAX_LOG_LINES) recent.shift();
}

/** Ring + stderr. */
export function logLine(scope, ...parts) {
  recordLine(scope, ...parts);
  console.error(`[${scope}] ${fmt(parts)}`);
}

export function recentLogs() {
  return recent.slice();
}
