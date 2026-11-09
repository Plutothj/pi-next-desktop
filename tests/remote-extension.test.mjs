// 单测内置远程扩展安装：幂等拷贝 pi-mobile 及其依赖树到隔离 agent 目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPiMobileExtension } from "../electron/remote-extension.js";

const ROOT = path.join(import.meta.dirname, "..");

test("内置远程：pi-mobile 与依赖树落进 extensions（幂等）", () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-agent-"));
  const first = installPiMobileExtension(agent, ROOT);
  assert.ok(first, "应安装 pi-mobile");
  const ext = path.join(agent, "extensions", "pi-mobile");
  assert.equal(fs.existsSync(path.join(ext, "src", "index.ts")), true);
  assert.equal(fs.existsSync(path.join(ext, "web", "index.html")), true);
  assert.equal(fs.existsSync(path.join(agent, "extensions", "node_modules", "qrcode")), true);
  assert.equal(fs.existsSync(path.join(agent, "extensions", "node_modules", "pi-speech")), true);
  assert.equal(fs.existsSync(path.join(agent, "extensions", "node_modules", "werift")), true);
  const marker = fs.readFileSync(path.join(ext, ".pi-mobile-version"), "utf8").trim();
  assert.match(marker, /^0\./);

  // 第二次调用不重复安装
  const second = installPiMobileExtension(agent, ROOT);
  assert.equal(second, first);

  // 用户已经通过 pi install 装过时，不装内置副本
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-mobile"] }, null, 2),
  );
  assert.equal(installPiMobileExtension(agent, ROOT), null);
  assert.equal(fs.existsSync(ext), false, "用户自装时应清掉内置副本");

  fs.rmSync(agent, { recursive: true, force: true });
});
