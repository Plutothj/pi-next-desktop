"use strict";
// pi 子进程隔离 preload（主进程以 --require 注入）：
// 第三方扩展经常硬编码 ~/.pi/agent/...（如 pi-memory 写 MEMORY.md），
// 不感知 PI_CODING_AGENT_DIR。这里在 fs 层把 <home>/.pi/agent/** 的读写
// 透明重定向到桌面隔离目录，让"天生隔离"成为兜底而不是逐插件打补丁。
// 只劫持 .pi 子树；homedir 其余用途（.gitconfig/.ssh 等）不受影响。
// 没有 PI_CODING_AGENT_DIR（非桌面环境，如 CLI 直接跑）时不做任何事。

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (agentDir) {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");

  const legacy = path.join(os.homedir(), ".pi", "agent") + path.sep;
  const legacyMatch = (process.platform === "win32" ? legacy.toLowerCase() : legacy);

  const redirect = (p) => {
    if (typeof p !== "string") return p;
    const probe = process.platform === "win32" ? p.toLowerCase() : p;
    if (!probe.startsWith(legacyMatch)) return p;
    return path.join(agentDir, p.slice(legacy.length));
  };

  // 首参为路径的读写族；cp/cpSync 源与目标都重定向（隔离目录是完整视图）
  const singlePath = [
    "writeFile", "writeFileSync", "appendFile", "appendFileSync", "readFile",
    "readFileSync", "stat", "statSync", "lstat", "lstatSync", "readdir",
    "readdirSync", "mkdir", "mkdirSync", "rm", "rmSync", "rmdir", "rmdirSync",
    "unlink", "unlinkSync", "access", "accessSync", "open", "openSync",
    "createReadStream", "createWriteStream",
  ];
  const twoPaths = ["cp", "cpSync"];

  const patch = (mod, names, both) => {
    for (const name of names) {
      const orig = mod[name];
      if (typeof orig !== "function") continue;
      const wrapped = both
        ? function (src, dest, ...rest) {
            return orig.call(this, redirect(src), redirect(dest), ...rest);
          }
        : function (p, ...rest) {
            return orig.call(this, redirect(p), ...rest);
          };
      Object.defineProperty(mod, name, { value: wrapped, configurable: true, writable: true });
    }
  };

  patch(fs, singlePath, false);
  patch(fs, twoPaths, true);
  patch(fsp, singlePath, false);
  patch(fsp, twoPaths, true);
}
