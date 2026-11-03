// 内置扩展安装器单测：幂等、绝对路径改写、marker 版本语义。
// 用真实 pi 安装器（runtime/），无需网络（bundle 是本地目录）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installBundledExtensions } from "../electron/bundled-extensions.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME = {
  node: path.join(ROOT, "runtime", "bin", process.platform === "win32" ? "node.exe" : "node"),
  cli: path.join(ROOT, "runtime", "cli.js"),
  env: {},
};
const BUNDLES = path.join(ROOT, "runtime", "bundled-extensions");
const hasRuntime = fs.existsSync(RUNTIME.cli) && fs.existsSync(BUNDLES);

function makeResources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "res-"));
  fs.cpSync(BUNDLES, path.join(dir, "bundled-extensions"), { recursive: true });
  return dir;
}

test("内置扩展：首次安装、幂等、绝对路径", { skip: hasRuntime ? false : "runtime 未 stage" }, async () => {
  const resources = makeResources();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));

  const first = await installBundledExtensions({
    resourcesPath: resources,
    agentDir,
    runtime: RUNTIME,
    appVersion: "1.0.0",
  });
  assert.equal(first.ok, true);
  assert.ok(first.installed.length >= 1, "至少装上一个");

  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.ok(Array.isArray(settings.packages) && settings.packages.length >= 1);
  for (const p of settings.packages) {
    assert.ok(path.isAbsolute(p), `必须是绝对路径（找工作区无关）: ${p}`);
    assert.ok(fs.existsSync(p), `路径必须存在: ${p}`);
  }

  // 同版本再跑：幂等
  const second = await installBundledExtensions({
    resourcesPath: resources,
    agentDir,
    runtime: RUNTIME,
    appVersion: "1.0.0",
  });
  assert.deepEqual(second.installed, [], "同版本不应重复安装");

  // marker 记录了版本
  const marker = JSON.parse(fs.readFileSync(path.join(agentDir, "bundled-extensions.json"), "utf8"));
  assert.equal(marker.version, "1.0.0");
  assert.ok(marker.handled.length >= 1);
});
