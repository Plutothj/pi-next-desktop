// 端到端验证图片内联（用后即删）：
// 用 pi 的 RPC 直接发带大图的 prompt，看返回的 user 消息里是 image block 还是
// "[Image omitted: could not be resized...]" 文本。
// 用 CDP 从渲染层发（走 window.pi.send，与 UI 路径一致）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9365;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-img-"));
const agentDir = path.join(base, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      deepseek: {
        name: "DeepSeek",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "x",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
      },
    },
  }),
);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }));
const pass = (n, ok, d = "") => console.log(`${n}: ${ok ? "PASS" : "FAIL"}${d ? ` (${d})` : ""}`);

const proc = spawn(
  "node.exe",
  [path.join(ROOT, "node_modules", "electron", "cli.js"), ".", `--remote-debugging-port=${PORT}`],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_CLI: path.join(ROOT, "runtime", "cli.js"),
      PI_NODE: path.join(ROOT, "runtime", "bin", "node.exe"),
      PI_DESKTOP_HOME: path.join(base, "home"),
      PI_USER_DATA: path.join(base, "userdata"),
      PI_AGENT_DIR: agentDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
proc.stderr.on("data", (d) => process.stderr.write("[app] " + d));
try {
  let t;
  for (let i = 0; i < 90 && !t; i++) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null);
    if (list) t = (await list.json()).find((x) => x.type === "page" && !/devtools/i.test(x.url));
    if (!t) await sleep(1000);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const evaluate = async (expr) => {
    const id = ++seq;
    const r = await new Promise((res) => {
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    return r.result?.result?.value;
  };
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`Boolean(window.__pi?.sessionFile)`).catch(() => false)) break;
    await sleep(1000);
  }

  // 在渲染层造一张 4000x3000 的 PNG（canvas），尺寸远超内联上限（通常 ~1MB）
  const made = await evaluate(`(async () => {
    const c = document.createElement("canvas");
    c.width = 4000; c.height = 3000;
    const ctx = c.getContext("2d");
    // 画噪声保证 PNG 无法靠压缩变小
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.random()*255;
      img.data[i+1] = Math.random()*255;
      img.data[i+2] = Math.random()*255;
      img.data[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    return JSON.stringify({ size: blob.size, b64len: Math.round(blob.size * 0.75) });
  })()`);
  console.log("BIG-IMG:", made);
  const info = JSON.parse(made);
  pass("I1 造出超大图（>2MB）", info.size > 2_000_000, `${(info.size / 1e6).toFixed(1)}MB`);

  // 通过真实 send 路径发出（data URI）
  const sent = await evaluate(`(async () => {
    const c = document.createElement("canvas");
    c.width = 4000; c.height = 3000;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i]=Math.random()*255; img.data[i+1]=Math.random()*255; img.data[i+2]=Math.random()*255; img.data[i+3]=255; }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL("image/png");
    const res = await window.pi.send({
      type: "prompt",
      message: "看看这张图",
      images: [{ type: "image", data: url, mimeType: "image/png" }],
      streamingBehavior: "followUp",
    }).catch(e => "ERR:" + e);
    await new Promise(r => setTimeout(r, 1500));
    const msgs = await window.pi.send({ type: "get_messages" }).catch(() => null);
    const user = (msgs?.messages ?? []).filter(m => m.role === "user").pop();
    const blocks = Array.isArray(user?.content) ? user.content : [];
    const hasImage = blocks.some(b => b.type === "image");
    const text = blocks.filter(b => b.type === "text").map(b => b.text).join(" ");
    return JSON.stringify({ hasImage, omitted: text.includes("Image omitted"), text: text.slice(0, 80) });
  })()`);
  const res = JSON.parse(sent);
  pass("I2 图片以内联 image block 传入", res.hasImage === true, sent);
  pass("I3 没有 Image omitted 提示", res.omitted === false, res.text);
  console.log("DONE");
  ws.close();
} finally {
  proc.kill("SIGKILL");
  try {
    execSync("taskkill /IM electron.exe /T /F", { stdio: "ignore" });
  } catch {}
  await sleep(1200);
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
}
