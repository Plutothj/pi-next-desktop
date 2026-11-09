import fs from "node:fs";
import path from "node:path";

// 内置远程模块：把 pi-mobile 作为应用自带的扩展装进隔离 agent 目录。
//
// 为什么不走"设置 → 扩展推荐"：远程是产品级能力，用户不该先装 npm 包。
// pi 的扩展发现会递归 extensions/ 下的目录（package.json 的 pi.extensions 或
// index.ts），依赖按扩展文件解析——所以 pi-mobile 及其整棵依赖树要落到
// <agent>/extensions/pi-mobile 与 <agent>/extensions/node_modules。

const MARKER = ".pi-mobile-version";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      // 依赖统一平铺到 extensions/node_modules；包内嵌套的 node_modules
      // 只在版本冲突时出现，这里不复制，避免体积翻倍。
      if (entry.name === "node_modules") continue;
      copyTree(path.join(src, entry.name), path.join(dst, entry.name));
    }
    return;
  }
  // 从 asar 读 + 普通写：copyFileSync 在打包后的 asar 路径上不可靠
  fs.writeFileSync(dst, fs.readFileSync(src));
}

function dependencyNames(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  return [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.optionalDependencies ?? {}),
  ];
}

function copyDependency(appRoot, name, destModules, seen) {
  if (seen.has(name) || name.startsWith("@earendil-works/")) return;
  seen.add(name);
  const src = path.join(appRoot, "node_modules", name);
  if (!fs.existsSync(src)) return;
  copyTree(src, path.join(destModules, name));
  for (const dep of dependencyNames(src)) copyDependency(appRoot, dep, destModules, seen);
}

/**
 * 把应用内置的 pi-mobile 安装到 <agent>/extensions/pi-mobile（幂等，按版本）。
 * 如果用户已经通过 pi install 装过同名包，跳过内置副本，避免 /remote 命令重复。
 */
export function installPiMobileExtension(agentDir, appRoot) {
  try {
    const source = path.join(appRoot, "node_modules", "pi-mobile");
    if (!fs.existsSync(source)) return null;
    const version = readJson(path.join(source, "package.json"))?.version;
    if (!version) return null;

    const settings = readJson(path.join(agentDir, "settings.json")) ?? {};
    const installed = (settings.packages ?? []).some((entry) => {
      const source = typeof entry === "string" ? entry : entry?.source;
      return typeof source === "string" && source.includes("pi-mobile");
    });
    if (installed) {
      // 用户自己通过 pi install 装了：清掉内置副本，避免 /remote 重复注册
      fs.rmSync(path.join(agentDir, "extensions", "pi-mobile"), {
        recursive: true,
        force: true,
      });
      return null;
    }

    const dir = path.join(agentDir, "extensions");
    const dest = path.join(dir, "pi-mobile");
    const marker = path.join(dest, MARKER);
    const current = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
    if (current === version && fs.existsSync(dest)) return dest;

    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(source, dest);
    const destModules = path.join(dir, "node_modules");
    const seen = new Set();
    for (const dep of dependencyNames(source)) copyDependency(appRoot, dep, destModules, seen);
    fs.writeFileSync(marker, `${version}\n`);
    return dest;
  } catch (err) {
    process.stderr.write(`[remote-ext] 安装失败: ${err}\n`);
    return null;
  }
}
