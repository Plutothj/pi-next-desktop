import fs from "node:fs";
import path from "node:path";

// table 扩展（Pi Desktop 维护，勿手改）：给模型一个读写 xlsx 的工具。
//
// 为什么是工具而不是让模型自己拼 CSV：
// - xlsx 带公式（=SUM/B2*C2…）才能真正"让 Excel 算"，CSV 做不到；
// - pi 内置 read 读不懂 xlsx（zip+XML），交给模型 read 只会吐出二进制垃圾。
//
// 依赖：xlsx（SheetJS）由 stage 脚本 vendor 进 runtime/node_modules（见
// scripts/stage-runtime.mjs 的 EXTRA_VENDOR）。

export const TABLE_EXTENSION_SOURCE = `// 由 Pi Desktop 维护（勿手改，会被重新生成）——表格读写工具。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
// SheetJS 体积不小（几百 KB 解析）：不要在扩展加载时 import，等真正调用
// table 工具时再动态加载（省每个 pi 进程的启动时间/内存）
let xlsxModule: any = null;
const loadXlsx = async () => {
  if (!xlsxModule) {
    const mod: any = await import("xlsx");
    xlsxModule = mod.default ?? mod;
  }
  return xlsxModule;
};

// 单元格：字符串/数字，或 { v: 值, f: "=SUM(B2:B5)" }（公式以 = 开头）
const Cell = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Object({
    v: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    f: Type.Optional(Type.String({ description: "Excel formula, e.g. =SUM(B2:B5)" })),
  }),
]);

const Params = Type.Object({
  action: StringEnum(["write", "read"] as const),
  path: Type.String({ description: "xlsx path, relative to the session cwd" }),
  sheets: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        rows: Type.Array(Type.Array(Cell)),
      }),
      { description: "For write: sheet name + 2D rows (first row is usually the header)" },
    ),
  ),
});

type Ctx = { cwd?: string };

const ROOT_LIMIT = 50 * 1024 * 1024; // 读入上限，防超大文件卡死
const READ_ROWS = 200;

function resolveSafe(cwd: string, rel: string) {
  const root = cwd;
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("path escapes the session cwd");
  return target;
}

function cellOf(raw: unknown) {
  if (raw === null || raw === undefined) return { v: "" };
  if (typeof raw === "number") return { v: raw };
  if (typeof raw === "string") {
    // 字符串以 = 开头是否当公式？只认对象形态，避免把普通文本误判成公式
    return { v: raw };
  }
  const obj = raw as { v?: unknown; f?: string };
  const out: { v?: unknown; f?: string } = {};
  if (obj.f) out.f = obj.f.replace(/^=/, "").trim();
  if (obj.v !== undefined && obj.v !== null) out.v = obj.v;
  else if (!out.f) out.v = "";
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "table",
    label: "Table",
    description:
      "Read or write spreadsheet files (.xlsx). Writing supports Excel formulas per cell so numbers are computed by Excel, not guessed by you. Actions: read(path), write(path, sheets)",
    promptSnippet:
      "Create or read .xlsx spreadsheets with real Excel formulas (=SUM(B2:B5), =B2*C2); use it whenever the user wants a table, a salary sheet, a cost comparison, or numbers that Excel should calculate",
    promptGuidelines: [
      "Use the table tool with action=write to produce any spreadsheet deliverable instead of writing CSV text: put labels and inputs as plain values and every derived number as a formula string (e.g. {f: \\"=SUM(B2:B5)\\"}) so Excel computes it.",
      "Use the table tool with action=read before modifying an existing .xlsx: it returns every sheet as tab-separated text (capped), which is the only reliable way to inspect spreadsheet contents.",
      "After writing with the table tool, tell the user which path was created and which sheets/formulas it contains; do not paste the whole table back into the reply.",
    ],
    parameters: Params,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: Ctx) {
      const cwd = path.resolve(ctx.cwd ?? process.cwd());
      let target: string;
      try {
        target = resolveSafe(cwd, params.path);
      } catch (err) {
        return errorResult(err);
      }
      if (!target.toLowerCase().endsWith(".xlsx")) {
        return errorResult(new Error("only .xlsx is supported"));
      }
      let XLSX: any;
      try {
        XLSX = await loadXlsx();
      } catch (err) {
        return errorResult(err);
      }

      if (params.action === "read") {
        try {
          if (!fs.existsSync(target)) return errorResult(new Error("file not found: " + params.path));
          const stat = fs.statSync(target);
          if (stat.size > ROOT_LIMIT) return errorResult(new Error("file too large (>50MB)"));
          // sheetStubs:true 才会把"只有公式、没有缓存值"的格子暴露出来
          const wb = XLSX.read(fs.readFileSync(target), {
            type: "buffer",
            cellFormula: true,
            sheetStubs: true,
          });
          const chunks: string[] = [];
          for (const name of wb.SheetNames) {
            const ws = wb.Sheets[name];
            const ref = ws["!ref"];
            if (!ref) {
              chunks.push("## " + name, "(empty)");
              continue;
            }
            const range = XLSX.utils.decode_range(ref);
            const lastRow = Math.min(range.e.r, READ_ROWS - 1);
            const rows: string[] = [];
            for (let r = range.s.r; r <= lastRow; r++) {
              const cells: string[] = [];
              for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = ws[XLSX.utils.encode_cell({ r, c })] as
                  | { f?: string; v?: unknown; w?: string }
                  | undefined;
                if (!cell) {
                  cells.push("");
                  continue;
                }
                // 公式优先显示成 =表达式，模型才知道这一列是算出来的
                if (cell.f) cells.push("=" + cell.f);
                else cells.push(String(cell.w ?? cell.v ?? ""));
              }
              rows.push(cells.join("\\t"));
            }
            chunks.push(
              "## " +
                name +
                (range.e.r > lastRow ? " (first " + (lastRow + 1) + " of " + (range.e.r + 1) + " rows)" : ""),
              rows.join("\\n"),
            );
          }
          return { content: [{ type: "text", text: chunks.join("\\n\\n") }] };
        } catch (err) {
          return errorResult(err);
        }
      }

      if (!params.sheets?.length) return errorResult(new Error("write needs sheets"));
      try {
        const wb = XLSX.utils.book_new();
        for (const sheet of params.sheets) {
          // 二维数组 → 工作表；公式格用坐标写入 cell.f（SheetJS 不认前导 =）
          const ws: any = {};
          let maxCol = 0;
          sheet.rows.forEach((row, r) => {
            row.forEach((raw, c) => {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = cellOf(raw);
              maxCol = Math.max(maxCol, c + 1);
              const out: any = { t: typeof cell.v === "number" ? "n" : "s" } as any;
              if (cell.v !== undefined) out.v = cell.v as string | number;
              if (cell.f) out.f = cell.f;
              ws[addr] = out;
            });
          });
          ws["!ref"] = XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: Math.max(sheet.rows.length - 1, 0), c: Math.max(maxCol - 1, 0) },
          });
          ws["!cols"] = Array.from({ length: maxCol }, () => ({ wch: 14 }));
          XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || "Sheet1");
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        XLSX.writeFile(wb, target);
        const stat = fs.statSync(target);
        return {
          content: [
            {
              type: "text",
              text: "已写入 " + params.path + "（" + params.sheets.map((s) => s.name).join(", ") + "，公式会由 Excel 打开时计算；" + stat.size + " bytes）",
            },
          ],
          details: { path: params.path, sheets: params.sheets.map((s) => s.name) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  });
};

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}
`;

// 扩展的 import 以扩展文件自身为基准解析（pi 只把 typebox / @earendil-works/*
// 别名到 runtime），所以 SheetJS 必须放在 extensions/node_modules 下。
// 源码目录来自应用自身依赖（打包后在 asar 内，读盘用 readFile 系列才可靠）。
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.writeFileSync(to, fs.readFileSync(from));
  }
}

export function installTableExtension(agentDir, xlsxSource) {
  try {
    const dir = path.join(agentDir, "extensions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "table.ts");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== TABLE_EXTENSION_SOURCE) fs.writeFileSync(file, TABLE_EXTENSION_SOURCE);

    // 依赖：按版本号做幂等复制（升级后自动覆盖）
    if (xlsxSource && fs.existsSync(path.join(xlsxSource, "package.json"))) {
      const version = JSON.parse(fs.readFileSync(path.join(xlsxSource, "package.json"), "utf8")).version;
      const marker = path.join(dir, "node_modules", ".xlsx-version");
      const installed = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
      if (installed !== version) {
        copyDir(xlsxSource, path.join(dir, "node_modules", "xlsx"));
        fs.writeFileSync(marker, version);
      }
    }
    return file;
  } catch (err) {
    process.stderr.write(`[table-ext] 安装失败: ${err}\n`);
    return null;
  }
}
