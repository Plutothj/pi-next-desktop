// 单测 table 扩展：jiti 直接加载 TS 源码（与 pi 运行时同一条加载路径），
// 假 ctx 调 execute()，再用 SheetJS 回读断言公式/类型/守卫。用户的真实诉求是
// "数字让 Excel 算"，所以公式是否真写进 xlsx 是核心断言（cellFormula+sheetStubs
// 才能读到"只有公式、无缓存值"的格子）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import XLSX from "xlsx";
import { installTableExtension } from "../electron/table-extension.js";

const runtimeModules = path.join(import.meta.dirname, "..", "runtime", "node_modules");
const appModules = path.join(import.meta.dirname, "..", "node_modules");

// @earendil-works/pi-* 由 pi 运行时提供，测试用桩替代（真实 xlsx 从应用依赖取）
const STUBS = {
  "@earendil-works/pi-ai": "export const StringEnum = (values) => ({ type: 'string', enum: values });",
};

async function loadTableExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "table-unit-"));
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });

  for (const [name, source] of Object.entries(STUBS)) {
    const target = path.join(dir, "node_modules", name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    fs.writeFileSync(path.join(target, "index.js"), source);
  }
  // pi 把 typebox 别名进 runtime；测试里从 runtime/node_modules 拷一份给 jiti 解析
  fs.cpSync(
    path.join(runtimeModules, "typebox"),
    path.join(dir, "node_modules", "typebox"),
    { recursive: true },
  );
  // 与 installTableExtension 真实行为一致：依赖落在扩展目录的 node_modules
  const file = installTableExtension(path.join(dir, "agent"), path.join(appModules, "xlsx"));
  assert.ok(file, "扩展安装成功");

  const require = createRequire(path.join(dir, "noop.cjs"));
  const jiti = require(path.join(runtimeModules, "jiti"));
  const createJiti = jiti.default ?? jiti;
  const loader = createJiti(path.join(dir, "noop.cjs"), { interopDefault: true });
  const mod = loader(file);
  const factory = mod.default ?? mod;

  const tools = new Map();
  factory({ registerTool: (def) => tools.set(def.name, def), on() {} });
  return { tool: tools.get("table"), work, dir };
}

const cellText = (res) => res.content?.[0]?.text ?? "";

test("table 扩展：写 xlsx 时公式真的落进单元格", async () => {
  const { tool, work, dir } = await loadTableExtension();
  assert.ok(tool, "table 工具已注册");
  assert.match(tool.promptSnippet, /formula/i, "提示词必须引导公式");
  assert.ok(
    tool.promptGuidelines.some((g) => g.includes("formula")),
    "promptGuidelines 必须点名公式",
  );

  const res = await tool.execute(
    "c1",
    {
      action: "write",
      path: "薪资测算.xlsx",
      sheets: [
        {
          name: "薪资构成",
          rows: [
            ["姓名", "基本工资", "绩效", "月合计", "社保", "应税"],
            ["张三", 18000, 4000, { f: "=B2+C2" }, { f: "=ROUND(D2*0.105,2)" }, { f: "=D2-E2" }],
          ],
        },
        { name: "参数", rows: [["社保比例", 0.105]] },
      ],
    },
    null,
    null,
    { cwd: work },
  );
  assert.notEqual(res.isError, true, cellText(res));

  const target = path.join(work, "薪资测算.xlsx");
  assert.ok(fs.existsSync(target), "文件落盘");
  const wb = XLSX.read(fs.readFileSync(target), { type: "buffer", cellFormula: true, sheetStubs: true });
  assert.deepEqual(wb.SheetNames, ["薪资构成", "参数"], "多 sheet 按顺序写入");
  const ws = wb.Sheets["薪资构成"];
  assert.equal(ws.D2.f, "B2+C2", "公式去掉前导 = 后写入");
  assert.equal(ws.E2.f, "ROUND(D2*0.105,2)", "ROUND 公式原样保留");
  assert.equal(ws.A2.v, "张三", "中文值原样");
  assert.equal(ws.B2.t, "n", "数字是数字而不是文本");

  // 读回：公式显示成 =表达式（模型据此知道这列是算出来的）
  const read = await tool.execute("c2", { action: "read", path: "薪资测算.xlsx" }, null, null, { cwd: work });
  const text = cellText(read);
  assert.match(text, /## 薪资构成/, "sheet 标题");
  assert.match(text, /=B2\+C2/, "读回显示公式");
  assert.match(text, /张三/, "读回显示值");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("table 扩展：路径与类型守卫", async () => {
  const { tool, work, dir } = await loadTableExtension();
  const sheets = [{ name: "S", rows: [["a"]] }];

  const escape = await tool.execute("c1", { action: "write", path: "../evil.xlsx", sheets }, null, null, { cwd: work });
  assert.equal(escape.isError, true, "越界路径必须拒绝");
  assert.match(cellText(escape), /escapes/);

  const badExt = await tool.execute("c2", { action: "write", path: "x.csv", sheets }, null, null, { cwd: work });
  assert.equal(badExt.isError, true, "非 xlsx 必须拒绝");

  const missing = await tool.execute("c3", { action: "read", path: "nope.xlsx" }, null, null, { cwd: work });
  assert.equal(missing.isError, true, "不存在的文件给明确错误");

  const noSheets = await tool.execute("c4", { action: "write", path: "x.xlsx" }, null, null, { cwd: work });
  assert.equal(noSheets.isError, true, "write 缺 sheets 报错");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("table 扩展：安装幂等（重复调用不重写、依赖按版本复制一次）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "table-install-"));
  const agent = path.join(dir, "agent");
  installTableExtension(agent);
  const dep = path.join(agent, "extensions", "node_modules", "xlsx", "package.json");
  assert.equal(fs.existsSync(dep), false, "不传 xlsxSource 时不复制依赖");

  installTableExtension(agent, path.join(appModules, "xlsx"));
  assert.ok(fs.existsSync(dep), "传了来源就复制");
  const marker = path.join(agent, "extensions", "node_modules", ".xlsx-version");
  assert.ok(fs.existsSync(marker), "版本标记写好");

  // 版本一致时再来一次：标记与依赖都不变（幂等）
  const before = fs.readFileSync(marker, "utf8");
  installTableExtension(agent, path.join(appModules, "xlsx"));
  assert.equal(fs.readFileSync(marker, "utf8"), before, "版本未变不重复复制");
  fs.rmSync(dir, { recursive: true, force: true });
});
