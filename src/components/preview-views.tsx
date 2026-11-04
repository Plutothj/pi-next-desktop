// 文件预览器：表格网格（AG Grid，可编辑 + 保存回 xlsx）、docx（mammoth HTML）、
// pdf（pdf.js canvas）。从 files-panel.tsx 拆出——那里只留面板壳与文件树。
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import DOMPurify from "dompurify";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// AG Grid v33+：模块注册一次（全量 Community 包，桌面应用不差这点体积）
ModuleRegistry.registerModules([AllCommunityModule]);

// pdf.js 需要 worker；Vite 把 worker 作为静态资源交给主进程 file:// 加载
GlobalWorkerOptions.workerSrc = workerUrl;

/** docx 预览要把 mammoth 的 HTML 塞进 DOM：文档内容不可信，先净化。 */
export const sanitizeHtml = (html: string) =>
  DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

/** 表格网格。editable 时单元格可改，改动经 onSave 写回 xlsx。 */
export function TableGrid({
  dark,
  editable = false,
  note,
  onDirtyChange,
  snapshotRef,
  rows,
}: {
  dark: boolean;
  editable?: boolean;
  note?: string;
  // 有未保存改动时通知外壳（决定是否显示保存条）
  onDirtyChange?: (dirty: boolean) => void;
  // 外壳持有同一个 ref，保存时直接读（比回调注册可靠，不受渲染时序影响）
  snapshotRef?: React.MutableRefObject<(() => string[][]) | undefined>;
  rows: string[][];
}) {
  const [q, setQ] = useState("");
  const [dirty, setDirty] = useState(false);
  const gridApi = useRef<{ getDisplayedRowCount?: () => number } | null>(null);
  const [head, ...body] = rows;
  const maxCols = Math.max(head?.length ?? 0, ...rows.slice(0, 200).map((r) => r.length), 1);

  const columnDefs = useMemo(
    () =>
      Array.from({ length: maxCols }, (_, i) => ({
        headerName: head?.[i] ?? String.fromCharCode(65 + (i % 26)),
        field: `c${i}`,
        sortable: true,
        resizable: true,
        flex: 1,
        minWidth: 72,
        cellClass: "font-mono",
        editable,
      })),
    [maxCols, head, editable],
  );

  // 行数据放 ref：编辑后就地改，保存时取最新值
  // 编辑副本：外层每次 render 都会给出新的 rows 数组引用，所以不能按引用判断
  // "数据源变了"。改为按内容摘要（首行 + 尺寸 + 末行）判断：只有外层真的重新
  // 读盘（AI 改写 / 手动刷新）才重置，用户编辑不会被冲掉。
  const current = useRef<string[][]>([head ?? [], ...body]);
  const signature = (rs: string[][]) =>
    [rs.length, rs[0]?.length ?? 0, rs[rs.length - 2]?.[0] ?? "", rs[rs.length - 1]?.[0] ?? ""].join("|");
  const lastSig = useRef(signature([head ?? [], ...body]));
  useEffect(() => {
    const sig = signature(rows);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    current.current = [head ?? [], ...body];
    setDirty(false);
    onDirtyChange?.(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: head/body 是 rows 的派生
  }, [rows]);

  const rowData = useMemo(
    () =>
      body.map((row, r) =>
        Object.fromEntries([
          ["__row", r],
          ...Array.from({ length: maxCols }, (_, c) => [`c${c}`, row[c] ?? ""]),
        ]),
      ),
    [body, maxCols],
  );

  const theme = useMemo(
    () =>
      themeQuartz.withParams(
        dark
          ? {
              backgroundColor: "#1b1c22",
              headerBackgroundColor: "#232429",
              foregroundColor: "#cfd2da",
              oddRowBackgroundColor: "#1f2026",
              borderColor: "#2e3038",
              headerTextColor: "#9aa0ac",
              accentColor: "#7aa2f7",
            }
          : {
              backgroundColor: "#ffffff",
              headerBackgroundColor: "#f3f4f6",
              foregroundColor: "#1f2328",
              oddRowBackgroundColor: "#fafafa",
              borderColor: "#e5e7eb",
              headerTextColor: "#57606a",
              accentColor: "#0969da",
            },
      ),
    [dark],
  );

  // 测试钩子：等价于用户在格子里输入（走同一条脏标记与数据更新通路），
  // 供 CDP 验证保存链路；生产环境无害（只是挂一个函数）。
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__agEditCell = (rowIndex: number, col: number, value: string) => {
      const grid = current.current;
      while (grid.length <= rowIndex + 1) grid.push([]);
      grid[rowIndex + 1][col] = value;
      setDirty(true);
      onDirtyChange?.(true);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__agEditCell;
    };
  }, [onDirtyChange]);

  // 外壳点保存时直接读这个 ref（含最新编辑）
  if (snapshotRef) snapshotRef.current = () => current.current;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <div className="flex h-6 items-center gap-1.5 rounded border bg-muted/30 px-2">
          <input
            className="w-32 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选行…"
            value={q}
          />
        </div>
        <span className="text-[10px] text-muted-foreground">
          {rows.length - 1} 行 × {maxCols} 列
        </span>
        {note ? <span className="text-[10px] text-amber-500/80">{note}</span> : null}
        {editable ? (
          dirty ? (
            <span className="text-[10px] text-amber-500">已修改，未保存</span>
          ) : (
            <span className="text-[10px] text-muted-foreground/70">可直接编辑单元格</span>
          )
        ) : null}
        <Button
          className="ml-auto h-6 px-1.5 text-[11px]"
          onClick={() => void navigator.clipboard.writeText(current.current.map((r) => r.join(",")).join("\n"))}
          size="sm"
          variant="ghost"
        >
          复制为 CSV
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact
          columnDefs={columnDefs}
          onCellValueChanged={(e) => {
            const row = typeof e.data?.__row === "number" ? e.data.__row : -1;
            const col = Number(String(e.colDef?.field ?? "").replace("c", ""));
            if (row < 0 || Number.isNaN(col)) return;
            const grid = current.current;
            while (grid.length <= row + 1) grid.push([]);
            grid[row + 1][col] = e.newValue == null ? "" : String(e.newValue);
            if (!dirty) {
              setDirty(true);
              onDirtyChange?.(true);
            }
          }}
          onGridReady={(e) => {
            gridApi.current = e.api;
            (window as unknown as Record<string, unknown>).__agGridApi = e.api;
            e.api.autoSizeAllColumns?.();
          }}
          quickFilterText={q.trim() || undefined}
          rowData={rowData}
          theme={theme}
        />
      </div>
    </div>
  );
}

/** CSV/TSV 预览（不可编辑：原文不是 xlsx，写回语义不同）。 */
export function DelimitedTable({
  content,
  dark,
  delimiter,
}: {
  content: string;
  dark: boolean;
  delimiter: string;
}) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .slice(0, 2000)
    .map((line) => line.split(delimiter));
  return (
    <TableGrid
      dark={dark}
      note={content.split(/\r?\n/).length > 2000 ? "行数较多，仅显示前 2000 行" : undefined}
      rows={rows}
    />
  );
}

/** docx 预览（净化后的 HTML + 排版样式）。 */
export function DocView({ html }: { html: string }) {
  return (
    <div
      className="doc-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-relaxed"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容已经 DOMPurify 净化（html profile，无脚本/事件属性）
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  );
}

type PdfDoc = Awaited<ReturnType<typeof getDocument>["promise"]>;
const loadPdf = async (data: Uint8Array): Promise<PdfDoc> => {
  const task = getDocument({ data });
  task.onPassword = () => {
    throw new Error("加密 PDF 暂不支持预览");
  };
  return task.promise;
};

/** PDF 预览：pdf.js 逐页渲染 canvas + 翻页。 */
export function PdfView({ data }: { data: Uint8Array }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadPdf(data)
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    doc
      .getPage(page)
      .then(async (pdfPage) => {
        if (cancelled || !canvasRef.current) return;
        const width = canvasRef.current.parentElement?.clientWidth ?? 340;
        const scale = width / pdfPage.getViewport({ scale: 1 }).width;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  if (error) return <p className="p-3 text-xs text-destructive">PDF 加载失败：{error}</p>;
  if (!doc) return <p className="p-3 text-xs text-muted-foreground">PDF 加载中…</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center justify-center gap-2 border-b px-2 py-1")}>
        <Button
          className="size-6 p-0"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground">
          {page} / {doc.numPages}
        </span>
        <Button
          className="size-6 p-0"
          disabled={page >= doc.numPages}
          onClick={() => setPage((p) => Math.min(doc.numPages, p + 1))}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-2">
        <canvas className="mx-auto block rounded bg-white shadow" ref={canvasRef} />
      </div>
    </div>
  );
}

/** 预览头部的「问 AI」：把当前文件（及内容）预填进输入框。
 * - xlsx：让模型用 table 工具读（它读得懂公式与多 sheet）
 * - docx/pdf：主进程抽文本内联（pi 的 read 读不懂二进制） */
export function AskAiButton({
  abs,
  cwd,
  onAsk,
  path,
  sheets,
}: {
  abs?: string;
  cwd: string;
  onAsk: (text: string) => void;
  path: string;
  sheets?: string[];
}) {
  const [busy, setBusy] = useState(false);
  const build = async () => {
    const ext = (abs ?? path).split(".").pop()?.toLowerCase() ?? "";
    if (ext === "xlsx" || ext === "xls") {
      onAsk(
        `用 table 工具 action=read 读取「${path}」${sheets?.length ? `（工作表：${sheets.join("、")}）` : ""}，然后：\n`,
      );
      return;
    }
    if (ext === "pdf" || ext === "docx") {
      setBusy(true);
      const res = await window.pi.extractText(cwd, path, abs).catch(() => null);
      setBusy(false);
      if (res?.ok && res.text) {
        const text = res.text.length > 15000 ? `${res.text.slice(0, 15000)}\n…（后略）` : res.text;
        onAsk(`以下是我打开的文档「${path}」的内容：\n\n${text}\n\n请基于以上内容：\n`);
        return;
      }
    }
    onAsk(`请分析文件「${path}」：\n`);
  };
  return (
    <Button
      className="ml-auto h-6 shrink-0 px-1.5 text-[11px]"
      disabled={busy}
      onClick={() => void build()}
      size="sm"
      title="把该文件带进输入框问 AI（xlsx 走 table 工具读取，docx/pdf 自动抽取文本）"
      variant="ghost"
    >
      {busy ? "读取中…" : "问 AI"}
    </Button>
  );
}
