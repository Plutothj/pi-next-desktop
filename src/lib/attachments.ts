// 附件分流（提交时）：对齐主流 agent 的做法——
// 图片走原生 image part；文本类内联进 prompt；pdf/docx 主进程提取纯文本内联；
// zip 解压到临时目录，把清单和路径给 pi 的 read/bash 工具；其余类型显式提示。
import type { FileUIPart } from "ai";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "xml", "html", "htm", "css", "js", "jsx", "ts",
  "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "hpp", "cs", "php", "sh", "bash", "zsh", "bat", "ps1", "sql", "env",
  "dockerfile", "makefile", "diff", "patch", "srt", "vtt", "properties",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MAX_DECODE_BYTES = 20 * 1024 * 1024; // 对齐 opencode：单附件 20MiB
const MAX_INLINE_CHARS = 50_000; // 单文件内联字符上限
const MAX_TOTAL_CHARS = 150_000; // 所有附件块合计上限

const cap = (text: string, limit = MAX_INLINE_CHARS) =>
  text.length > limit ? `${text.slice(0, limit)}\n…（已截断，原文共 ${text.length} 字符）` : text;

const looksBinary = (text: string) => {
  let bad = 0;
  const n = Math.min(text.length, 2000);
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if ((code < 9 && code !== 0) || (code > 13 && code < 32) || code === 0xfffd) bad++;
  }
  return bad / Math.max(1, n) > 0.05;
};

const decode = async (part: FileUIPart) => {
  const res = await fetch(part.url); // data: 与 blob: 都可
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_DECODE_BYTES) throw new Error("超过 20MB 上限");
  return buf;
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const wrap = (name: string, note: string, body?: string) =>
  body === undefined
    ? `【附件 ${name}${note ? `：${note}` : ""}】`
    : `<attachment name="${name}">${note ? `\n（${note}）` : ""}\n${body}\n</attachment>`;

export async function expandAttachments(
  files?: FileUIPart[],
): Promise<{ images: FileUIPart[]; extraText: string }> {
  const images: FileUIPart[] = [];
  const blocks: string[] = [];
  let total = 0;

  for (const part of files ?? []) {
    const name = part.filename || "attachment";
    const mime = part.mediaType ?? "";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";

    if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) {
      images.push(part);
      continue;
    }
    if (total >= MAX_TOTAL_CHARS) {
      blocks.push(wrap(name, "超出附件总量上限，未解析"));
      continue;
    }

    try {
      if (ext === "pdf" || mime === "application/pdf") {
        const bytes = await decode(part);
        const res = await window.pi.parseAttachment({ name, dataBase64: toBase64(bytes) });
        if (!res.ok || res.kind !== "text") throw new Error(res.ok ? "解析结果为空" : res.error);
        const text = cap(res.text, 60_000);
        total += text.length;
        blocks.push(wrap(name, "PDF 提取的纯文本，版式与图片未保留", text || "（未提取到文本，可能是扫描件）"));
      } else if (ext === "docx" || mime.includes("wordprocessingml")) {
        const bytes = await decode(part);
        const res = await window.pi.parseAttachment({ name, dataBase64: toBase64(bytes) });
        if (!res.ok || res.kind !== "text") throw new Error(res.ok ? "解析结果为空" : res.error);
        const text = cap(res.text, 60_000);
        total += text.length;
        blocks.push(wrap(name, "docx 提取的纯文本，格式信息未保留", text || "（空文档）"));
      } else if (["xlsx", "xls", "xlsm"].includes(ext) || mime.includes("spreadsheetml")) {
        const bytes = await decode(part);
        const res = await window.pi.parseAttachment({ name, dataBase64: toBase64(bytes) });
        if (!res.ok || res.kind !== "text") throw new Error(res.ok ? "解析结果为空" : res.error);
        const text = cap(res.text, 60_000);
        total += text.length;
        blocks.push(wrap(name, "表格转 CSV（按 Sheet 分节，公式与样式未保留）", text || "（空表格）"));
      } else if (ext === "zip" || mime === "application/zip") {
        const bytes = await decode(part);
        const res = await window.pi.parseAttachment({ name, dataBase64: toBase64(bytes) });
        if (!res.ok || res.kind !== "zip") throw new Error(res.ok ? "解压结果异常" : res.error);
        const listing = cap(res.files.join("\n"), 20_000);
        total += listing.length;
        blocks.push(
          wrap(
            name,
            `zip 已解压到 ${res.dir}（共 ${res.count} 个文件）。用 read/bash 工具查看这些文件，不要重新解压。`,
            listing,
          ),
        );
      } else if (TEXT_EXT.has(ext) || mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) {
        const bytes = await decode(part);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (looksBinary(text)) {
          blocks.push(wrap(name, "二进制文件，暂不支持解析"));
        } else {
          const capped = cap(text);
          total += capped.length;
          blocks.push(wrap(name, "", capped));
        }
      } else {
        blocks.push(wrap(name, "暂不支持解析此类型"));
      }
    } catch (err) {
      blocks.push(wrap(name, `解析失败：${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return { images, extraText: blocks.join("\n\n") };
}
