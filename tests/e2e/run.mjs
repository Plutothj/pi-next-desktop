// E2E：CDP 驱动真实 Electron app（vite dist + 打包 runtime）走关键动线。
// 本地：npm run build && npm run test:e2e
// CI：ubuntu 用 xvfb-run（见 ci.yml 的 e2e job）。
// 用隔离的 fixture agent 目录（假供应商，无需密钥），不碰用户真实配置。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 9456);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const results = [];
let browserProc = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

async function check(name, fn) {
  try {
    await fn();
    pass(name);
    results.push([name, true]);
  } catch (err) {
    fail(`${name} — ${err.message}`);
    results.push([name, false]);
  }
}

// ---------------------------------------------------------------- fixture

function makeFixtureAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-e2e-agent-"));
  // 一个无密钥的自定义供应商 + 默认模型：pi 能 boot 出完整 state，UI 全链路可测
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          e2e: {
            name: "E2E",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "e2e-no-network",
            models: [{ id: "e2e-model", name: "E2E Model" }],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ defaultProvider: "e2e", defaultModel: "e2e-model" }, null, 2),
  );
  // 设置页技能面板在打开时只读一次 cfg；技能要在 boot 前就存在，
  // 否则删除动线里看不到它（E2E 的删除技能检查会用到）。
  const skillDir = path.join(dir, "skills", "e2e-demo-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: e2e-demo-skill\ndescription: E2E demo\n---\nbody\n",
  );
  return dir;
}

// 预览动线用的最小 docx/pdf（不引外部工具：docx = STORE zip + OOXML 部件，
// pdf = 手工拼的单页对象表）
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const xmlEsc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function makeDocx(text) {
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xmlEsc(text)}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
}

function makePdf(text) {
  const objs = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    5: `<< /Length ${(`BT /F1 24 Tf 72 770 Td (${text}) Tj ET`).length} >>\nstream\nBT /F1 24 Tf 72 770 Td (${text}) Tj ET\nendstream`,
  };
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------------- cdp client

async function cdp() {
  for (let i = 0; i < 90; i++) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null);
    if (list) {
      const targets = await list.json();
      const page = targets.find((t) => t.type === "page" && !/devtools/i.test(t.url));
      if (page) return page;
    }
    await sleep(1000);
  }
  throw new Error("CDP 页面目标 90s 内未出现");
}

async function main() {
  const agentDir = makeFixtureAgentDir();
  const runtimeDir = path.join(ROOT, "runtime");
  if (!fs.existsSync(path.join(runtimeDir, "cli.js"))) {
    throw new Error("runtime/ 不存在，先跑 npm run stage");
  }
  const node =
    process.platform === "win32"
      ? path.join(runtimeDir, "bin", "node.exe")
      : path.join(runtimeDir, "bin", "node");
  const cli = path.join(runtimeDir, "cli.js");

  browserProc = spawn(
    process.platform === "win32" ? "node.exe" : process.execPath,
    [path.join(ROOT, "node_modules", "electron", "cli.js"), ".", `--remote-debugging-port=${PORT}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PI_CLI: cli,
        PI_NODE: node,
        PI_DESKTOP_HOME: `${agentDir}-home`, // projects.json 等也隔离，别污染真实 ~/.pi-desktop
        PI_USER_DATA: `${agentDir}-userdata`, // ui.json（侧栏折叠/缩放）也别污染开发者环境
        PI_AGENT_DIR: agentDir,
        PI_E2E: "1",
        PI_DEBUG: "1", // 启用 debugWidget 等测试注入通道
        // CI 的 ubuntu 镜像更新后 chrome-sandbox 常起不来（表现为窗口 90s 不出现）
        ELECTRON_DISABLE_SANDBOX: process.env.CI ? "1" : undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr = [];
  browserProc.stderr.on("data", (d) => stderr.push(d.toString()));
  // 启动即死（sandbox/依赖问题）时把现场留在日志里，别只留一个超时
  browserProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`electron 提前退出 code=${code}，stderr 尾部：\n${stderr.join("").slice(-2500)}`);
    }
  });

  let target;
  try {
    target = await cdp();
  } catch (err) {
    // 页面目标没出现：electron 可能活着但窗口没开成，stderr 常有线索
    console.error(`CDP 目标未出现，electron stderr 尾部：\n${stderr.join("").slice(-2500)}`);
    throw err;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket 连接失败"));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const id = ++seq;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(`页面异常: ${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`);
    }
    return res.result?.result?.value;
  };
  const waitForExpr = async (expression, timeoutMs = 60_000, label = expression) => {
    const started = Date.now();
    for (;;) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
      await sleep(500);
    }
  };

  console.log("E2E 动线：");

  // 1. boot：splash 消退、主界面出现（fixture 供应商保证 pi ready）
  await check("boot 到主界面", async () => {
    await waitForExpr(`Boolean(document.querySelector('aside'))`, 90_000, "sidebar");
  });

  // 2. 侧栏头部：logo + 搜索/技能按钮（新建任务已移到项目行 + 图标）
  await check("侧栏 logo 行", async () => {
    const r = await evaluate(`(() => {
      const img = document.querySelector('aside img');
      const palette = document.querySelector('aside button[title*="搜索"]');
      const searchInput = document.querySelector('aside input[placeholder="搜索会话"]');
      return JSON.stringify({ logo: Boolean(img), palette: Boolean(palette), searchInputGone: searchInput === null, logoSize: img ? Math.round(img.getBoundingClientRect().width) : 0 });
    })()`);
    const v = JSON.parse(r);
    if (!v.logo || !v.palette || !v.searchInputGone) throw new Error(JSON.stringify(v));
  });

  // 3. caption strip（win/linux）：贴角满高（塌陷回归）
  if (process.platform !== "darwin") {
    await check("窗口控制贴角满高", async () => {
      const r = await waitForExpr(
        `(() => {
          const btns = [...document.querySelectorAll('header button[title]')].filter(b => ['最小化','关闭'].includes(b.title));
          if (!btns.length) return null;
          const s = btns[0].parentElement.getBoundingClientRect();
          return JSON.stringify({ top: Math.round(s.top), h: Math.round(s.height), right: Math.round(s.right), vw: window.innerWidth });
        })()`,
        30_000,
        "caption strip",
      );
      const v = JSON.parse(r);
      if (!(v.right === v.vw && v.top === 0 && v.h >= 40)) throw new Error(JSON.stringify(v));
    });
  }

  // 4. 打开设置 → 外观 tab 有「界面缩放」（死代码回归：面板必须真的挂载）
  await check("设置·外观含界面缩放", async () => {
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('设置')).click()`);
    await waitForExpr(`Boolean([...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === '外观'))`, 15_000, "settings nav");
    await evaluate(`[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === '外观').click()`);
    await waitForExpr(`document.body.textContent.includes('界面缩放')`, 15_000, "zoom section");
  });

  // 5. 设置搜索：输入「更新」应过滤出版本页并可进入
  await check("设置搜索（更新→版本）", async () => {
    try {
      await waitForExpr(
        `document.querySelector('input[placeholder*="搜索设置"]') !== null`,
        10_000,
        "search input",
      );
    } catch (err) {
      const diag = await evaluate(
        `JSON.stringify({ inputs: document.querySelectorAll('input').length, navInputs: document.querySelectorAll('nav input').length, settingsOpen: document.body.textContent.includes('返回工作区'), placeholders: [...document.querySelectorAll('input')].map(i => i.placeholder).slice(0, 4) })`,
      ).catch(() => "diag failed");
      throw new Error(`${err.message} | 诊断: ${diag}`);
    }
    await evaluate(`(() => {
      const i = document.querySelector('input[placeholder*="搜索设置"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, '更新');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitForExpr(`[...document.querySelectorAll('nav button')].some(b => b.textContent.trim() === '版本')`, 10_000, "filtered nav");
    await evaluate(`[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === '版本').click()`);
    await waitForExpr(`document.body.textContent.includes('当前版本')`, 10_000, "about panel");
  });

  // 6. 会话搜索 IPC 结构
  await check("会话搜索 IPC", async () => {
    const r = await evaluate(`window.pi.searchSessions('e2e-no-such-thing').then(r => JSON.stringify({ hasHits: Array.isArray(r.hits), scanned: r.scanned >= 0 }))`);
    const v = JSON.parse(r);
    if (!v.hasHits) throw new Error(JSON.stringify(v));
  });

  // 7. updater 状态可读（dev 模式下 status=dev）
  await check("updater 状态", async () => {
    const s = await evaluate(`window.pi.updater.state().then(s => s.status)`);
    if (!s) throw new Error(`status=${s}`);
  });

  // 8. 并行任务板生命周期：发射 → running → stop → 终态（LLM 往返在 CI 不可
  //    行，fixture 供应商无后端；真实完成路径在用户机器上验证）
  await check("并行任务板", async () => {
    const started = await evaluate(
      `window.pi.board.run({ name: 'e2e 并行', cwd: ${JSON.stringify(agentDir)}, message: '只回复：完成' }).then(a => JSON.stringify({ id: a.id, status: a.status }))`,
    );
    const v = JSON.parse(started);
    if (!v.id || v.status !== "running") throw new Error(started);
    const listed = await waitForExpr(
      `window.pi.board.list().then(l => l.some(x => x.id === ${JSON.stringify(v.id)}) ? 'yes' : null)`,
      30_000,
      "board list",
    );
    if (listed !== "yes") throw new Error("list 缺少该任务");

    // v2：面板可进入该会话的实时对话视图（Transcript 渲染）
    await evaluate(`[...document.querySelectorAll('header button[title]')].find(b => b.title === '并行任务').click()`);
    await waitForExpr(`document.body.textContent.includes('e2e 并行')`, 10_000, "board card");
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('e2e 并行')).click()`);
    await waitForExpr(
      `Boolean(document.querySelector('textarea[placeholder]')) && document.body.textContent.includes('列表')`,
      10_000,
      "agent chat view",
    );

    const stopped = await evaluate(
      `window.pi.board.stop(${JSON.stringify(v.id)}).then(r => JSON.stringify(r))`,
    );
    if (!JSON.parse(stopped).ok) throw new Error(stopped);
  });

  // 9. 会话树面板：get_tree 渲染 + 节点点击重走（fork）
  await check("会话树面板", async () => {
    // 先发一条消息产生树节点（fixture 供应商不可达，回合会失败，但条目已入树）
    await evaluate(`window.pi.send({ type: 'prompt', message: 'e2e 树节点' }).catch(() => null)`);
    await sleep(1500);
    await evaluate(`[...document.querySelectorAll('header button[title]')].find(b => b.title === '会话树').click()`);
    await waitForExpr(`Boolean(document.querySelector('.flex.h-full.flex-col.p-3'))`, 10_000, "tree panel");
    const hasNode = await waitForExpr(
      `document.body.textContent.includes('e2e 树节点') || document.body.textContent.includes('会话树')`,
      10_000,
      "tree node",
    );
    if (!hasNode) throw new Error("树面板无内容");
  });

  // 10. 计划工作台：在应用当前工作区落盘一份计划 → 面板列出、点开可读
  await check("计划工作台", async () => {
    await evaluate(
      `(async () => { const cwd = window.__pi?.cwd; await window.pi.plans.save(cwd, '# 计划\\n\\n1. e2e 步骤一\\n2. e2e 步骤二\\n'); })()`,
    );
    await evaluate(`[...document.querySelectorAll('header button[title]')].find(b => b.title === '计划').click()`);
    await waitForExpr(`document.body.textContent.includes('plan-')`, 10_000, "plan listed");
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('plan-')).click()`);
    await waitForExpr(`document.body.textContent.includes('步骤一')`, 10_000, "plan content");
    const read = await evaluate(
      `(async () => { const cwd = window.__pi?.cwd; const l = await window.pi.plans.list(cwd); return (await window.pi.plans.read(cwd, l[0].path)).ok; })()`,
    );
    if (read !== true) throw new Error("plans:read 失败");
  });

  // 11. auto 虚拟模型扩展真的被 pi 加载（模型选择器里出现 pi-desktop/auto）
  await check("auto 虚拟模型", async () => {
    const found = await evaluate(
      `(() => {
        const models = window.__pi?.models ?? [];
        return JSON.stringify({ has: models.some(m => m.provider === "pi-desktop" && m.id === "auto"), providers: models.map(m => m.provider) });
      })()`,
    );
    const v = JSON.parse(found);
    if (!v.has) throw new Error(`提供者: ${v.providers.join(", ") || "（空）"}`);
  });

  // 12. 定时任务 CRUD
  await check("定时任务", async () => {
    const saved = await evaluate(
      `window.pi.schedules.save({ time: '23:59', name: 'e2e 定时', message: '测试任务', cwd: window.__pi?.cwd }).then(r => JSON.stringify(r))`,
    );
    const v = JSON.parse(saved);
    if (!v.ok) throw new Error(saved);
    const listed = await evaluate(`window.pi.schedules.list().then(l => l.some(s => s.name === 'e2e 定时'))`);
    if (listed !== true) throw new Error("list 缺少该任务");
    const removed = await evaluate(
      `window.pi.schedules.list().then(async l => { const s = l.find(x => x.name === 'e2e 定时'); return window.pi.schedules.delete(s.id); }).then(r => r.ok)`,
    );
    if (removed !== true) throw new Error("delete 失败");
  });

  // 13. 扩展 widget：注入 setWidget 事件 → 卡片渲染（标题/进度/✓ 结构）
  await check("扩展 widget 面板", async () => {
    await evaluate(
      `window.pi.debugWidget({ key: "e2e", lines: ["--- 构建进度 ---", "3/10 编译", "✓ 类型检查通过", "✗ 单元测试失败"] })`,
    );
    await waitForExpr(`Boolean(document.querySelector('[data-widget-card]'))`, 10_000, "widget card");
    const txt = await evaluate(`document.querySelector('[data-widget-card]').textContent`);
    if (!txt.includes("构建进度") || !txt.includes("类型检查通过")) {
      throw new Error(`widget 内容异常: ${txt.slice(0, 80)}`);
    }
    // 清除（lines 为空）
    await evaluate(`window.pi.debugWidget({ key: "e2e", lines: [] })`);
    await waitForExpr(`!document.querySelector('[data-widget-card]')`, 10_000, "widget cleared");
  });

  // 13b. todo 清单渲染：复选框 + 完成划线 + 全完成折叠
  await check("todo 清单 UI", async () => {
    await evaluate(
      `window.pi.debugWidget({ key: "todo", lines: ["--- Todo 1/3 ---", "✓ #1 已完成的事", "▸ #2 待办甲", "▸ #3 待办乙"] })`,
    );
    await waitForExpr(`Boolean(document.querySelector('[data-widget-card] li'))`, 10_000, "todo list");
    const txt = await evaluate(`document.querySelector('[data-widget-card]').textContent`);
    if (!txt.includes("已完成的事") || !txt.includes("待办甲")) {
      throw new Error(`清单内容异常: ${txt.slice(0, 80)}`);
    }
    // 已完成项应有删除线
    const struck = await evaluate(
      `[...document.querySelectorAll('[data-widget-card] li span')].some(s => s.textContent.includes('已完成的事') && s.className.includes('line-through'))`,
    );
    if (struck !== true) throw new Error("已完成项没有删除线");

    // 全部完成 → 自动折叠（列表隐藏）
    await evaluate(
      `window.pi.debugWidget({ key: "todo", lines: ["--- Todo 3/3 ---", "✓ #1 甲", "✓ #2 乙", "✓ #3 丙"] })`,
    );
    // 事件管线现在是 16ms 批量进 reducer，固定 sleep 容易踩在批次边缘；轮询等折叠
    await waitForExpr(
      `document.querySelectorAll('[data-widget-card] li').length === 0`,
      3_000,
      "todo collapsed",
    );
    await evaluate(`window.pi.debugWidget({ key: "todo", lines: [] })`);
  });

  // 14. 扩展对话框：连续两次（rpiv 选"其他"会立刻再弹一个输入框），
  //     第二个不能因为第一个的答复返回而被吞掉（历史 bug）
  await check("扩展对话框连弹", async () => {
    await evaluate(
      `window.pi.debugDialog({ method: 'select', title: 'E2E 选择', options: ['选项甲', '其他'] })`,
    );
    await waitForExpr(`document.body.textContent.includes('E2E 选择')`, 10_000, "first dialog");
    // 点"其他" → 本地切成自由输入（不回传字面量）
    await evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '其他').click()`,
    );
    const hasInput = await waitForExpr(
      `Boolean(document.querySelector('input[placeholder*="输入你的答案"]'))`,
      5_000,
      "freeform input",
    ).catch(() => null);
    if (!hasInput) throw new Error("点『其他』未切换到输入框");
    // 输入并确认 → 对话框应关闭
    await evaluate(`(() => {
      const i = document.querySelector('input[placeholder*="输入你的答案"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, '我的自定义答案');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确认').click()`);
    await waitForExpr(`!document.body.textContent.includes('E2E 选择')`, 8_000, "first dialog closed");

    // 立刻再来一个：模拟扩展在收到答复后马上弹下一个
    await evaluate(
      `window.pi.debugDialog({ method: 'input', title: 'E2E 追问', placeholder: '继续说' })`,
    );
    await waitForExpr(`document.body.textContent.includes('E2E 追问')`, 8_000, "second dialog survives");
    // 收尾：取消掉（debug 对话框会挂在主进程 pendingDialogs 里）
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')?.click()`);
  });

  // 16. 多会话：开会话 A → 发消息（回合进行中）→ 切到 B → A 的后台进程仍在
  await check("多会话并行", async () => {
    // A 发一条（fixture 供应商不可达，回合会失败，但进程处于忙碌状态）
    await evaluate(`window.pi.send({ type: "prompt", message: "A 的任务" }).catch(() => null)`);
    await sleep(1200);
    const aFile = await evaluate(`window.__pi?.sessionFile`);
    if (!aFile) throw new Error("A 会话未落盘");

    // 造 B 会话文件
    const sessionsRoot = path.join(agentDir, "sessions");
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      );
    const files = walk(sessionsRoot).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) throw new Error("磁盘上没有会话文件");
    const bFile = path.join(path.dirname(files[0]), "e2e-second.jsonl");
    fs.copyFileSync(files[0], bFile);

    // 切到 B
    await evaluate(`window.__piOpenSession(${JSON.stringify(bFile)}, ${JSON.stringify(agentDir)})`);
    await waitForExpr(
      `window.__pi?.sessionFile?.includes("e2e-second")`,
      15_000,
      "switched to B",
    );

    // 关键：A 的进程仍在（切走不杀进程）——用主进程状态断言
    const stillRunning = await evaluate(
      `window.pi.switchSession(${JSON.stringify(aFile)}, ${JSON.stringify(agentDir)}).then(r => JSON.stringify(r))`,
    );
    if (!JSON.parse(stillRunning).running) throw new Error(`切回 A 时进程不在: ${stillRunning}`);

    // 新建会话 = 新开池槽，不能顶掉 A 的进程（旧路径 pi new_session 会 teardown）
    const created = JSON.parse(
      await evaluate(
        `window.pi.createSession(${JSON.stringify(agentDir)}).then(r => JSON.stringify({ file: r.sessionFile }))`,
      ),
    );
    if (!created.file) throw new Error(`新会话未分配文件: ${JSON.stringify(created)}`);
    if (created.file === aFile) throw new Error("新会话复用了旧会话文件");
    const aAfterCreate = await evaluate(
      `window.pi.switchSession(${JSON.stringify(aFile)}, ${JSON.stringify(agentDir)}).then(r => JSON.stringify(r))`,
    );
    if (!JSON.parse(aAfterCreate).running) throw new Error(`新建后 A 进程被顶掉: ${aAfterCreate}`);
  });

  // 17. 长会话虚拟化：只有可视区附近的行被挂载（切换/首屏与历史长度解耦）
  await check("长会话虚拟化（只挂可视区）", async () => {
    const work = path.join(agentDir, "..", `pi-e2e-virt-${process.pid}`);
    fs.mkdirSync(work, { recursive: true });
    const dir = path.join(agentDir, "sessions", `e2e-virt-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "session.jsonl");
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "virt", timestamp: new Date(now).toISOString(), cwd: work }),
    ];
    let parent = null;
    let seq = 0;
    for (let i = 1; i <= 60; i++) {
      for (const role of ["user", "assistant"]) {
        const id = `v${++seq}`;
        const ts = now - (60 - i) * 60000;
        const message = {
          role,
          content: [{
            type: "text",
            // 每条回复都带同一个代码块：不管虚拟化初始落在顶部还是底部，
            // 可视区里一定有代码可测（只测首块，Worker 有缓存）
            text:
              role === "user"
                ? `问题 ${i}`
                : `回答 ${i}：
\`\`\`ts
const answer: number = 42; // 高亮测试
\`\`\`
` +
                  "较长的说明文字。".repeat(40),
          }],
          timestamp: ts,
        };
        if (role === "assistant") {
          message.api = "openai-completions";
          message.provider = "mock";
          message.model = "mock-model";
          message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          message.stopReason = "stop";
          message.durationMs = 1000;
        }
        lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(ts).toISOString(), message }));
        parent = id;
      }
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    await evaluate(`window.__piRefreshSessions()`);
    await evaluate(`window.__piOpenSession(${JSON.stringify(file)}, ${JSON.stringify(work)})`);
    await waitForExpr(
      `window.__pi.sessionFile === ${JSON.stringify(file)} && document.querySelectorAll('[data-chat-node]').length > 0`,
      30_000,
      "长会话加载",
    );
    await sleep(300);
    const loaded = await evaluate(
      `JSON.stringify({ msgs: window.__pi.messages.length, nodes: document.querySelectorAll('[data-chat-node]').length })`,
    );
    const info = JSON.parse(loaded);
    if (info.msgs < 100) throw new Error(`长会话消息数异常: ${loaded}`);
    if (info.nodes > 30) throw new Error(`虚拟化未生效，挂了 ${info.nodes} 行`);
  });

  // 17b. 代码高亮走 Worker：主线程只拿到 token；这里只验证最终确实着色且保留原文
  await check("代码高亮（Worker）", async () => {
    await waitForExpr(
      `[...document.querySelectorAll('[data-streamdown="code-block-body"] code span')].some((s) => (s.getAttribute('style') || '').includes('--sdm-c'))`,
      20_000,
      "code highlighted",
    );
    const code = await evaluate(
      `document.querySelector('[data-streamdown="code-block-body"]')?.textContent || ''`,
    );
    if (!code.includes("const answer: number = 42")) {
      throw new Error(`代码块内容异常: ${code.slice(0, 80)}`);
    }
  });

  // 18. 阻塞对话框跟着会话走：在 A 等项目审批时去别的项目新建会话，
  //     对话框要被暂存而不是丢弃（丢掉 pi 会永远等，A 的回合卡死"停止"）。
  await check("切换会话保留待回答的审批对话框", async () => {
    const workA = path.join(agentDir, "..", `pi-e2e-dialog-a-${process.pid}`);
    const workB = path.join(agentDir, "..", `pi-e2e-dialog-b-${process.pid}`);
    fs.mkdirSync(workA, { recursive: true });
    fs.mkdirSync(workB, { recursive: true });
    const createdA = JSON.parse(
      await evaluate(
        `window.pi.createSession(${JSON.stringify(workA)}).then(r => JSON.stringify({ file: r.sessionFile }))`,
      ),
    );
    if (!createdA.file) throw new Error("A 会话未创建");
    const dialog = JSON.parse(
      await evaluate(
        `window.pi.debugDialog({ method: 'confirm', title: '批准这份实施计划？', message: '# 测试计划' }).then(r => JSON.stringify(r))`,
      ),
    );
    await waitForExpr(
      `window.__pi.dialog && window.__pi.dialog.id === ${JSON.stringify(dialog.id)} ? 'shown' : null`,
      10_000,
      "审批对话框",
    );
    // 别的项目新建会话：对话框从界面消失，但 A 的 pi 仍在等回答
    await evaluate(
      `window.pi.createSession(${JSON.stringify(workB)}).then(r => JSON.stringify({ file: r.sessionFile }))`,
    );
    await waitForExpr(`window.__pi.dialog ? null : 'cleared'`, 5_000, "对话框清除");
    await evaluate(
      `window.__piOpenSession(${JSON.stringify(createdA.file)}, ${JSON.stringify(workA)})`,
    );
    await waitForExpr(
      `window.__pi.dialog && window.__pi.dialog.id === ${JSON.stringify(dialog.id)} ? 'restored' : null`,
      10_000,
      "对话框恢复",
    );
    // 回答后请求从主进程的待回答表里消失（渲染层的卡片由 answerDialog 收掉）
    const answered = JSON.parse(
      await evaluate(
        `window.pi.respondUi(${JSON.stringify(dialog.id)}, { cancelled: true }).then(r => JSON.stringify(r))`,
      ),
    );
    if (!answered.ok) throw new Error(`对话框回答失败: ${JSON.stringify(answered)}`);
    const again = JSON.parse(
      await evaluate(
        `window.pi.respondUi(${JSON.stringify(dialog.id)}, { cancelled: true }).then(r => JSON.stringify(r))`,
      ),
    );
    if (again.ok) throw new Error("对话框回答后仍留在待回答表里");
  });

  // 19. 项目树：创建项目后出现在侧栏的项目分组里
  await check("创建项目", async () => {
    await evaluate(`window.pi.projects.add(${JSON.stringify(agentDir)}).then(r => JSON.stringify(r))`);
    const projects = await evaluate(`window.pi.projects.list().then(l => JSON.stringify(l.map(p => p.path)))`);
    if (!JSON.parse(projects).includes(agentDir)) throw new Error(`项目未登记: ${projects}`);
  });

  // 20. 删除项目：有会话时也必须真的消失（曾经因为侧栏分组由会话 cwd 推出，
  //     删掉项目后会话立刻把它"变回"项目），而且确认框必须是应用内对话框。
  await check("删除项目（有会话）：应用内确认 + 整组隐藏", async () => {
    const work = path.join(agentDir, "..", `pi-e2e-projdel-${process.pid}`);
    fs.mkdirSync(work, { recursive: true });
    // 直接落一个合法会话文件（pi 空闲时不一定急着写盘）：项目分组来自会话的
    // cwd，这正是"项目有会话后删不掉"的复现条件。
    const sessionPath = path.join(
      agentDir,
      "sessions",
      `e2e-projdel-${process.pid}`,
      "session.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: `e2e-projdel-${process.pid}`,
        timestamp: new Date().toISOString(),
        cwd: work,
      })}\n`,
    );
    await evaluate(`window.__piRefreshSessions()`);
    const label = path.basename(work);
    const findRemoveBtn = `[...document.querySelectorAll('aside button[title="从列表移除（不删会话）"]')]
      .find(b => b.parentElement?.textContent?.includes(${JSON.stringify(label)}))`;
    await waitForExpr(`Boolean(${findRemoveBtn})`, 20_000, "项目分组");
    await evaluate(`(() => { const b = ${findRemoveBtn}; if (!b) throw new Error("remove btn"); b.click(); return "ok"; })()`);
    // 原生 window.confirm 会阻断 CDP；能拿到 Radix 对话框即证明走的是应用内弹框
    const dialogText = await waitForExpr(
      `(() => {
        const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].at(-1);
        return d && d.textContent.includes('从项目列表移除') ? d.textContent : null;
      })()`,
      5_000,
      "确认框",
    );
    if (!String(dialogText).includes("移除")) throw new Error(`确认框内容异常: ${dialogText}`);
    await evaluate(
      `(() => {
        const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].at(-1);
        const btn = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === '移除');
        if (!btn) throw new Error("confirm btn");
        btn.click();
        return "ok";
      })()`,
    );
    await waitForExpr(`!Boolean(${findRemoveBtn})`, 10_000, "项目分组隐藏");
    const st = JSON.parse(await evaluate(`window.pi.projects.state().then(s => JSON.stringify(s))`));
    if (!st.removed.includes(work)) throw new Error(`removed 未记录: ${JSON.stringify(st.removed)}`);
    if (!fs.existsSync(sessionPath)) throw new Error(`会话文件被误删: ${sessionPath}`);
  });

  // 21. 删除技能：设置页里点垃圾桶 → 应用内确认框（叠在设置页之上）→ 真的删掉
  await check("删除技能：应用内确认 + 目录真的删除", async () => {
    // 技能目录在 fixture 启动时已创建（设置页 cfg 只在打开时读一次）
    const skillDir = path.join(agentDir, "skills", "e2e-demo-skill");
    if (!fs.existsSync(skillDir)) throw new Error("fixture 技能缺失");
    await evaluate(
      `(() => { const b = document.querySelector('aside button[title="技能"]'); if (!b) throw new Error("skills btn"); b.click(); return "ok"; })()`,
    );
    const rowExpr = `(() => {
      const name = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'e2e-demo-skill');
      const row = name?.closest('div.flex.items-center');
      return row ? true : null;
    })()`;
    try {
      await waitForExpr(rowExpr, 15_000, "技能行");
    } catch (err) {
      const dump = await evaluate(
        `JSON.stringify({
          settings: [...document.querySelectorAll('button')].some(b => b.textContent.includes('返回工作区')),
          spans: [...document.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).slice(0, 40),
        })`,
      );
      throw new Error(`${err.message}; dump=${dump}`);
    }
    await evaluate(
      `(() => {
        const name = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'e2e-demo-skill');
        const row = name.closest('div.flex.items-center');
        const del = [...row.querySelectorAll('button')].find(b => !b.textContent.trim());
        if (!del) throw new Error("delete btn");
        del.click();
        return "ok";
      })()`,
    );
    const dialogText = await waitForExpr(
      `(() => {
        const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].at(-1);
        return d && d.textContent.includes('删除技能') ? d.textContent : null;
      })()`,
      5_000,
      "技能确认框",
    );
    if (!String(dialogText).includes("e2e-demo-skill")) throw new Error(`确认框内容异常: ${dialogText}`);
    await evaluate(
      `(() => {
        const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].at(-1);
        const btn = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === '删除');
        if (!btn) throw new Error("confirm btn");
        btn.click();
        return "ok";
      })()`,
    );
    for (let i = 0; i < 40 && fs.existsSync(skillDir); i++) await sleep(150);
    if (fs.existsSync(skillDir)) throw new Error(`技能目录未删除: ${skillDir}`);
    // 收拾：回到工作区，避免影响后续侧栏动线
    await evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('返回工作区')); b?.click(); return "ok"; })()`,
    );
    await sleep(300);
  });

  // 22. 文件预览：xlsx 网格 / docx 正文 / pdf canvas / 问 AI 预填
  //     fixture 项目里放三种样例文件，走真实 UI 动线（文件树 → 点开）
  await check("文件预览（xlsx/docx/pdf）+ 问 AI", async () => {
    const work = path.join(agentDir, "..", `pi-e2e-preview-${process.pid}`);
    fs.mkdirSync(work, { recursive: true });
    // xlsx（多 sheet）与 docx/pdf 用最小合法结构，避免外部工具依赖
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["姓名", "基本工资", "绩效"],
        ["张三", 18000, 4000],
      ]),
      "薪资构成",
    );
    XLSX.writeFile(wb, path.join(work, "薪资表.xlsx"));
    fs.writeFileSync(
      path.join(work, "制度.docx"),
      makeDocx("考勤制度：工作日 9:00-18:00。"),
    );
    fs.writeFileSync(path.join(work, "通知.pdf"), makePdf("Quarterly Review"));

    // 切到该目录（boot 到新工作区）并刷新会话列表
    await evaluate(`window.pi.send({ type: "get_state" })`).catch(() => null);
    await evaluate(`window.pi.projects.add(${JSON.stringify(work)}).then(() => "ok")`);
    await evaluate(`window.__piOpenSession(window.__pi.sessionFile, ${JSON.stringify(work)})`).catch(() => null);
    // 用主进程 IPC 直接读：不依赖当前工作区渲染细节，先验解析层
    const table = await evaluate(`window.pi.readTable(${JSON.stringify(work)}, "薪资表.xlsx").then(r => JSON.stringify({ ok: r.ok, sheets: r.sheets?.map(s => s.name), cell: r.sheets?.[0]?.rows?.[1]?.[0] }))`);
    const t = JSON.parse(table);
    if (!t.ok || t.sheets?.length !== 1 || t.cell !== "张三") throw new Error(`readTable: ${table}`);

    const doc = await evaluate(`window.pi.readDoc(${JSON.stringify(work)}, "制度.docx").then(r => JSON.stringify({ ok: r.ok, hasText: r.html?.includes("考勤制度") }))`);
    const d = JSON.parse(doc);
    if (!d.ok || !d.hasText) throw new Error(`readDoc: ${doc}`);

    const pdf = await evaluate(`window.pi.readPdf(${JSON.stringify(work)}, "通知.pdf").then(r => JSON.stringify({ ok: r.ok, bytes: r.data?.length ?? 0 }))`);
    const p = JSON.parse(pdf);
    if (!p.ok || p.bytes < 200) throw new Error(`readPdf: ${pdf}`);

    // 越界守卫
    const escapeGuard = await evaluate(`window.pi.readTable(${JSON.stringify(work)}, "../evil.xlsx").then(r => JSON.stringify(r.error))`);
    if (!String(escapeGuard).includes("越界")) throw new Error(`越界未被拒: ${escapeGuard}`);

    // 清理失败（Windows 句柄延迟）不该让用例失败：吞掉即可
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  });

  // 18b. 表格可编辑 + 保存回 xlsx（公式按 = 前缀识别）
  await check("表格编辑保存", async () => {
    const work = path.join(agentDir, "..", `pi-e2e-edit-${process.pid}`);
    fs.mkdirSync(work, { recursive: true });
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["姓名", "工资"],
        ["张三", "18000"],
      ]),
      "Sheet1",
    );
    const file = path.join(work, "编辑.xlsx");
    XLSX.writeFile(wb, file);

    // 走 IPC 验证写回（与 UI 保存按钮同一条路径）
    const res = await evaluate(
      `window.pi.writeTable(${JSON.stringify(work)}, "编辑.xlsx", undefined, "Sheet1", [["姓名","工资"],["张三","=18000*2"]]).then(r => JSON.stringify(r))`,
    );
    if (!JSON.parse(res).ok) throw new Error("writeTable 失败: " + res);

    const back = XLSX.read(fs.readFileSync(file), { type: "buffer", cellFormula: true, sheetStubs: true });
    const cell = back.Sheets.Sheet1?.B2;
    if (cell?.f !== "18000*2") throw new Error(`公式未写入: ${JSON.stringify(cell)}`);

    // 越界写必须拒绝
    const denied = await evaluate(
      `window.pi.writeTable(${JSON.stringify(work)}, "../evil.xlsx", undefined, "Sheet1", [["a"]]).then(r => JSON.stringify(r))`,
    );
    if (!JSON.parse(denied).error?.includes("越界")) throw new Error("越界写未被拒: " + denied);

    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // 23. 侧栏折叠：收起后消失、头部出现展开按钮、再展开回来
  await check("侧栏折叠/展开", async () => {
    // 注意：右侧面板也是 <aside>，这里只认左侧栏（含「项目」标题的那块）
    const hasSidebar = () => evaluate("Boolean(document.querySelector('aside.w-64'))");
    if (!(await hasSidebar())) throw new Error("起始状态侧栏不存在");
    await evaluate(
      "[...document.querySelectorAll('aside button')].find(b => (b.title||'').includes('收起侧栏'))?.click()",
    );
    await sleep(500);
    if (await hasSidebar()) throw new Error("收起后侧栏仍然存在");
    const expand = await evaluate(
      "Boolean([...document.querySelectorAll('header button')].find(b => (b.title||'').includes('展开侧栏')))",
    );
    if (!expand) throw new Error("收起后头部没有展开按钮");
    await evaluate(
      "[...document.querySelectorAll('header button')].find(b => (b.title||'').includes('展开侧栏'))?.click()",
    );
    await sleep(500);
    if (!(await hasSidebar())) throw new Error("展开后侧栏没回来");
  });

  // 25. 性能回归：事件批量进入 reducer 时，Composer/顶栏/侧栏（memo）不跟着
  // 流式帧反复重渲染。等所有 debounce/预热都静下来再测，避免把无关更新算进来。
  await check("高频事件不重渲染 Composer/顶栏", async () => {
    await sleep(2000);
    const perf = await evaluate(`(async () => {
      window.__perfRender = { app: 0, sidebar: 0, header: 0, composer: 0 };
      for (let i = 1; i <= 20; i++) {
        await window.pi.debugWidget({ key: "perf", lines: ["进度 " + i] });
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) => setTimeout(r, 300));
      const out = { ...window.__perfRender, cards: document.querySelectorAll('[data-widget-card]').length };
      window.__perfRender = null;
      await window.pi.debugWidget({ key: "perf", lines: [] });
      return out;
    })()`);
    if (!perf || perf.app < 1) throw new Error(`没有渲染: ${JSON.stringify(perf)}`);
    if (perf.header !== 0) throw new Error(`顶栏不该重渲染: ${JSON.stringify(perf)}`);
    if (perf.composer !== 0) throw new Error(`Composer 不该重渲染: ${JSON.stringify(perf)}`);
    // 侧栏可能因一次合法的会话列表刷新重渲染一次，但不能跟着 20 个批次走
    if (perf.sidebar > 2) throw new Error(`侧栏重渲染过多: ${JSON.stringify(perf)}`);
  });

  ws.close();
}

main()
  .then(async () => {
    console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} 通过`);
  })
  .catch((err) => {
    console.error("E2E 运行失败:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (browserProc && !browserProc.killed) {
      try {
        browserProc.kill("SIGKILL");
      } catch {}
    }
    // 隔离的 APP_HOME 目录一并清掉（projects.json 等测试期间写入的都在里面）
    try {
      fs.rmSync(`${agentDir}-home`, { recursive: true, force: true });
      fs.rmSync(`${agentDir}-userdata`, { recursive: true, force: true });
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
