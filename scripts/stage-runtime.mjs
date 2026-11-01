// Copy pi's self-contained bundle into runtime/ so the packaged app ships its
// own agent. The bundle only imports node builtins, so no node_modules needed.
//
// On machines without a local pi install (e.g. CI), write a placeholder
// runtime instead: the packaged app then falls back to the user's managed
// install at runtime (see resolveRuntime). A `.placeholder` marker keeps
// resolveRuntime from mistaking it for a real bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "runtime");
const install = path.join(os.homedir(), ".pi", "agent", "install");

function stagePlaceholder() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, ".placeholder"),
    "No local pi install found at stage time; the packaged app will use the user's managed install.\n",
  );
  console.log("runtime staged: placeholder (no local pi install) — packaged app falls back to ~/.pi/agent/install");
}

let version;
try {
  version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
} catch {
  stagePlaceholder();
  process.exit(0);
}
const bundle = path.join(
  install, "releases", version, "node_modules",
  "@earendil-works", "pi-coding-agent", "dist", "bundle",
);
if (!fs.existsSync(path.join(bundle, "cli.js"))) {
  stagePlaceholder();
  process.exit(0);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(bundle, out, { recursive: true });

for (const must of ["cli.js", "cli-runtime.js", "chunks"]) {
  if (!fs.existsSync(path.join(out, must))) throw new Error(`staged runtime 缺少 ${must}`);
}

// Extensions written in TypeScript are loaded through jiti, which the bundle
// requires at runtime instead of bundling.
const modulesSrc = path.join(install, "releases", version, "node_modules", "jiti");
// electron-builder drops node_modules from extraResources, so use vendor/ + NODE_PATH.
const modulesOut = path.join(out, "vendor", "jiti");
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
fs.cpSync(modulesSrc, modulesOut, { recursive: true });

fs.writeFileSync(path.join(out, "VERSION"), `${version}\n`);
console.log(`runtime staged: pi ${version} → ${out}`);
