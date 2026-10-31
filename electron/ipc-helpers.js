// Pure validation helpers shared by IPC handlers (no Electron imports).

export function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

export function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  return value;
}

export function requireObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value;
}

/** Resolves a cwd argument, falling back to the home directory. */
export function resolveDir(cwd, existsSync, homedir) {
  if (typeof cwd === "string" && cwd && existsSync(cwd)) return cwd;
  return homedir;
}
