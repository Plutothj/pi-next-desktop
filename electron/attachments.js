// 附件解析（主进程）：pdf/docx 提取纯文本，zip 解压到临时目录。
// 渲染层把附件 base64 传进来，解析结果以内联文本或"解压路径 + 文件清单"
// 形式进入 prompt——与 opencode 的做法对齐（文本内联、二进制转文本/给工具路径），
// zip 不进模型，交给 pi 的 read/bash 工具。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import { logLine } from "./logs.js";

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_UNCOMPRESSED = 500 * 1024 * 1024;

export async function parseAttachment({ name, dataBase64 } = {}) {
  const bytes = Buffer.from(String(dataBase64 ?? ""), "base64");
  if (!bytes.length) throw new Error("空文件");
  const lower = String(name ?? "").toLowerCase();

  if (lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return { ok: true, kind: "text", text: String(text ?? "") };
  }

  if (lower.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { ok: true, kind: "text", text: value };
  }

  if ([".xlsx", ".xls", ".xlsm"].some((ext) => lower.endsWith(ext))) {
    const wb = XLSX.read(bytes, { type: "buffer" });
    // 每 sheet 转 CSV（跳过全空行），单 sheet 超过 5000 行截断并标注
    const parts = wb.SheetNames.map((sheetName) => {
      let csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false });
      const rows = csv.split("\n");
      if (rows.length > 5000) {
        csv = `${rows.slice(0, 5000).join("\n")}\n…（${sheetName} 共 ${rows.length} 行，已截断）`;
      }
      return `## Sheet: ${sheetName}\n${csv}`;
    });
    return { ok: true, kind: "text", text: parts.join("\n\n") };
  }

  if (lower.endsWith(".zip")) {
    if (bytes.length > MAX_ZIP_BYTES) throw new Error("zip 超过 100MB");
    const zip = new AdmZip(bytes);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length > MAX_ZIP_ENTRIES) throw new Error("zip 条目数超过 2000");
    const uncompressed = entries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
    if (uncompressed > MAX_ZIP_UNCOMPRESSED) throw new Error("zip 解压总量超过 500MB");

    // 防 zip-slip：拒绝绝对路径与 .. 穿越
    const unsafe = entries.some((e) => {
      const normalized = path.normalize(e.entryName);
      return path.isAbsolute(normalized) || normalized.split(path.sep).includes("..");
    });
    if (unsafe) throw new Error("zip 含不安全的路径条目，已拒绝解压");

    const dir = path.join(os.tmpdir(), "pi-attachments", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    zip.extractAllTo(dir, true);
    const files = entries.map((e) => e.entryName).slice(0, 500);
    logLine("attachments", `zip ${bytes.length}B → ${dir}（${entries.length} 个文件）`);
    return { ok: true, kind: "zip", dir, files, count: entries.length };
  }

  throw new Error("不支持解析该类型");
}
