// Stage a self-contained runtime into runtime/ for packaging:
//   runtime/            pi's bundle (from the local managed install, else npm)
//   runtime/vendor/jiti + runtime/node_modules/jiti TS 扩展加载器（CJS 走 NODE_PATH，ESM 走 node_modules）
//   runtime/bin/node    official Node runtime (portable, no system node needed)
//
// The packaged app sets PI_CODING_AGENT_DIR to ~/.pi-desktop/agent, so this
// runtime plus that directory makes the client fully independent from the
// user's own pi installation.
//
// On machines without network and without a local pi install, a placeholder
// runtime is written and the app falls back to the user's managed install.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "runtime");
const install = path.join(os.homedir(), ".pi", "agent", "install");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function stagePlaceholder() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, ".placeholder"),
    "No local pi install and npm fetch failed; the packaged app will use the user's managed install.\n",
  );
  console.log("runtime staged: placeholder — packaged app falls back to ~/.pi/agent/install");
}

/** curl honours HTTPS_PROXY/HTTP_PROXY, unlike Node's fetch. */
function curl(url, output) {
  execFileSync("curl", ["-fsSL", "--max-time", "180", "-o", output, url], { stdio: "inherit" });
}

function nodeBinName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

/** Downloads an official Node tarball and copies just its node binary. */
async function stageNode() {
  const target = path.join(out, "bin", nodeBinName());
  if (fs.existsSync(target)) {
    console.log(`node already staged: ${target}`);
    return;
  }
  const mirror = process.env.NODE_MIRROR || "https://nodejs.org/dist";
  const major = process.env.NODE_MAJOR || "24";
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  const sumsUrl = `${mirror}/latest-v${major}.x/SHASUMS256.txt`;

  const cacheDir = process.env.NODE_CACHE_DIR || path.join(os.homedir(), ".cache", "pi-desktop-node");
  fs.mkdirSync(cacheDir, { recursive: true });

  const sumsFile = path.join(cacheDir, `SHASUMS-v${major}.txt`);
  curl(sumsUrl, sumsFile);
  const line = fs.readFileSync(sumsFile, "utf8").split("\n")
    .find((l) => l.trim().endsWith(`-${platform}-${arch}.${ext}`));
  if (!line) throw new Error(`SHASUMS 中找不到 ${platform}-${arch} 的 node v${major}`);
  const filename = line.trim().split(/\s+/).pop();
  const archive = path.join(cacheDir, filename);
  if (!fs.existsSync(archive)) {
    console.log(`downloading ${filename}…`);
    curl(`${mirror}/latest-v${major}.x/${filename}`, archive);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-node-"));
  try {
    // Windows 的 tar 对 "C:\..." 路径不可靠（GNU 报 remote host、bsdtar 缺开关），
    // zip 直接走 Expand-Archive；类 Unix 用系统 tar。
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmp}' -Force`],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("tar", ["-xf", archive, "-C", tmp], { stdio: "inherit" });
    }
    const inner = fs.readdirSync(tmp).find((name) => name.startsWith("node-v"));
    if (!inner) throw new Error("node tarball 结构异常");
    const binPath = process.platform === "win32"
      ? path.join(tmp, inner, "node.exe")
      : path.join(tmp, inner, "bin", "node");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(binPath, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    const version = execFileSync(target, ["--version"]).toString().trim();
    console.log(`node staged: ${filename} (${version}) -> ${target}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Local managed install first; npm as the CI fallback. */
function locateBundle() {
  try {
    const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
    const modules = path.join(install, "releases", version, "node_modules");
    const bundle = path.join(modules, PI_PACKAGE, "dist", "bundle");
    const jiti = path.join(modules, "jiti");
    if (fs.existsSync(path.join(bundle, "cli.js"))) {
      return { version, bundle, modules, jiti: fs.existsSync(jiti) ? jiti : null };
    }
  } catch {
    // fall through to npm
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-npm-"));
  console.log(`no local pi install; fetching ${PI_PACKAGE} from npm…`);
  const npmArgs = ["install", "--no-save", "--prefix", tmp, `${PI_PACKAGE}@latest`, "jiti"];
  if (process.platform === "win32") {
    // Node refuses to spawn .cmd shims directly (EINVAL); route via cmd.exe.
    execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs], { stdio: "inherit" });
  } else {
    execFileSync("npm", npmArgs, { stdio: "inherit" });
  }
  const modules = path.join(tmp, "node_modules");
  const pkgDir = path.join(modules, PI_PACKAGE);
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  return {
    version,
    bundle: path.join(pkgDir, "dist", "bundle"),
    modules,
    jiti: fs.existsSync(path.join(modules, "jiti")) ? path.join(modules, "jiti") : null,
  };
}

let staged;
try {
  staged = locateBundle();
} catch (err) {
  console.warn("pi bundle unavailable:", err.message);
  stagePlaceholder();
  process.exit(0);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(staged.bundle, out, { recursive: true });

for (const must of ["cli.js", "cli-runtime.js", "chunks"]) {
  if (!fs.existsSync(path.join(out, must))) throw new Error(`staged runtime 缺少 ${must}`);
}

if (staged.jiti) {
  // electron-builder drops node_modules from extraResources, so use vendor/ + NODE_PATH.
  fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
  fs.cpSync(staged.jiti, path.join(out, "vendor", "jiti"), { recursive: true });
}

// ---------------------------------------------------------------- 外部依赖补全

// bundle 是 externalize 打包：运行时 require 的 npm 包不进 chunks。逐个手补
// 会漏（jiti、quickjs-wasi 就是这么漏掉的），所以扫描 bundle 里的
// require("<bare>") 调用，把命中且存在于安装树的包自动补进 runtime/node_modules
// ——ESM 解析只认 node_modules 目录，NODE_PATH 对它无效。
const NODE_BUILTINS =
  /^(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\/|$)/;

function bareRequiresOf(dir) {
  const found = new Set();
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      // require("pkg/sub") 与 createRequire(...).resolve("pkg/sub")（codemode 的
      // quickjs-wasi/quickjs.wasm 就是这种形态）都算
      for (const m of src.matchAll(
        /(?:\brequire|\.resolve)\(\s*["']([@a-z0-9][@a-z0-9._/-]*)["']\s*\)/gi,
      )) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
        const bare = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (!NODE_BUILTINS.test(bare)) found.add(bare);
      }
    }
  };
  visit(dir);
  return found;
}

// 平台相关的原生可选模块（ws 的加速依赖，有纯 JS 回退），交叉平台 stage 不带
const SKIP_VENDOR = new Set(["bufferutil", "utf-8-validate"]);

if (staged.modules) {
  const externals = bareRequiresOf(out);
  externals.add("jiti"); // 扩展加载器兜底（即使某天 bundle 形态变化也不漏）
  fs.mkdirSync(path.join(out, "node_modules"), { recursive: true });
  const vendored = [];
  for (const name of [...externals].sort()) {
    if (SKIP_VENDOR.has(name)) continue;
    const src = path.join(staged.modules, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(out, "node_modules", name), { recursive: true });
    vendored.push(name);
  }
  // vendor 里同步一份 jiti：CJS 侧（NODE_PATH）兜底，ESM 侧用 node_modules 副本
  const jitiCopy = path.join(out, "node_modules", "jiti");
  if (fs.existsSync(jitiCopy)) {
    fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
    fs.cpSync(jitiCopy, path.join(out, "vendor", "jiti"), { recursive: true });
  }
  console.log(`vendored runtime deps: ${vendored.join(", ") || "(none)"}`);
}

fs.writeFileSync(path.join(out, "VERSION"), `${staged.version}\n`);
console.log(`pi runtime staged: ${staged.version} → ${out}`);

try {
  await stageNode();
} catch (err) {
  console.warn("node runtime not staged (app falls back to a system node):", err.message);
}
