import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf.js 需要 worker；Vite 把 worker 作为静态资源交给主进程 file:// 加载
GlobalWorkerOptions.workerSrc = workerUrl;
import {
  BracesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  GitBranchIcon,
  GlobeIcon,
  Loader2Icon,
  LockIcon,
  PaletteIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { baseName, cn } from "@/lib/utils";
import type { GitStatus, TreeEntry } from "@/lib/pi";
import { ChangesPanel } from "@/components/changes-panel";

// AG Grid v33+：模块注册一次（全量 Community 包，桌面应用不差这点体积）
ModuleRegistry.registerModules([AllCommunityModule]);

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json",
  md: "markdown", css: "css", html: "html", py: "python", rs: "rust",
  go: "go", sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql",
};

// Directories that are build output or metadata: shown dimmed, like ZCode.
const DIMMED_DIRS = new Set(["node_modules", "dist", "release", "runtime", "build", ".git"]);

type ChangeStatus = "modified" | "untracked";

/** File-type icon + color, approximating ZCode's file tree. */
function iconFor(name: string) {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() ?? "" : "";
  const base = "size-3.5 shrink-0";
  if (lower === ".gitignore" || lower === ".gitattributes") {
    return <GitBranchIcon className={cn(base, "text-orange-500")} />;
  }
  if (lower.includes("lock")) return <LockIcon className={cn(base, "text-amber-500")} />;
  switch (ext) {
    case "ts":
    case "tsx":
      return <FileCodeIcon className={cn(base, "text-sky-400")} />;
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return <FileCodeIcon className={cn(base, "text-yellow-400")} />;
    case "json":
      return <BracesIcon className={cn(base, "text-amber-500")} />;
    case "md":
      return <FileTextIcon className={cn(base, "text-sky-500")} />;
    case "html":
      return <GlobeIcon className={cn(base, "text-orange-400")} />;
    case "css":
    case "scss":
      return <PaletteIcon className={cn(base, "text-violet-400")} />;
    case "sh":
    case "zsh":
      return <SquareTerminalIcon className={cn(base, "text-emerald-400")} />;
    case "xlsx":
    case "xls":
    case "csv":
    case "tsv":
      return <FileSpreadsheetIcon className={cn(base, "text-emerald-500")} />;
    case "docx":
    case "doc":
      return <FileTypeIcon className={cn(base, "text-blue-400")} />;
    case "pdf":
      return <FileTextIcon className={cn(base, "text-rose-400")} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "svg":
    case "gif":
    case "webp":
      return <FileImageIcon className={cn(base, "text-pink-400")} />;
    default:
      return <FileIcon className={cn(base, "text-muted-foreground")} />;
  }
}

function StatusDot({ status }: { status: ChangeStatus | null }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "ml-auto size-1.5 shrink-0 rounded-full",
        status === "modified" ? "bg-amber-500" : "bg-emerald-500",
      )}
      title={status === "modified" ? "有未提交修改" : "未跟踪"}
    />
  );
}

export function FilesPanel({
  cwd,
  changes,
  dark = true,
}: {
  cwd: string;
  changes?: GitStatus["changes"];
  dark?: boolean;
}) {
  const [tab, setTab] = useState<"changes" | "tree">("changes");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [_loading, setLoading] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  // xlsx/xls 结构化预览（多 sheet）
  const [workbook, setWorkbook] = useState<{
    path: string;
    sheets: { name: string; rows: string[][]; truncatedRows?: boolean }[];
    truncatedSheets?: boolean;
  } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  // docx → HTML 预览
  const [doc, setDoc] = useState<{ path: string; html: string } | null>(null);
  // pdf → 渲染层 pdf.js 预览
  const [pdf, setPdf] = useState<{ path: string; data: Uint8Array } | null>(null);

  const loadDir = useCallback(
    async (dir: string) => {
      setLoading((prev) => new Set(prev).add(dir));
      const entries = await window.pi.tree(cwd, dir).catch(() => []);
      setChildren((prev) => ({ ...prev, [dir]: entries }));
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    },
    [cwd],
  );

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setFile(null);
    setQuery("");
    loadDir("");
  }, [loadDir]);

  // Search uses the bounded directory walk in the main process.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let alive = true;
    window.pi.files(cwd, query.trim()).then((files) => {
      if (alive) setResults(files);
    });
    return () => {
      alive = false;
    };
  }, [cwd, query]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir]) void loadDir(dir);
      }
      return next;
    });
  };

  const refresh = () => {
    setExpanded(new Set());
    setChildren({});
    void loadDir("");
  };

  // path -> deepest status, aggregated for directories.
  const fileStatus = useMemo(() => {
    const map = new Map<string, ChangeStatus>();
    for (const change of changes ?? []) map.set(change.path, change.untracked ? "untracked" : "modified");
    return map;
  }, [changes]);

  const statusOf = useCallback(
    (path: string, isDir: boolean): ChangeStatus | null => {
      if (!changes?.length) return null;
      if (!isDir) return fileStatus.get(path) ?? null;
      // Untracked dirs are reported as a single entry for the directory.
      const direct = fileStatus.get(path);
      if (direct) return direct;
      const prefix = `${path}/`;
      let untracked = false;
      for (const change of changes) {
        if (!change.path.startsWith(prefix)) continue;
        if (!change.untracked) return "modified";
        untracked = true;
      }
      return untracked ? "untracked" : null;
    },
    [changes, fileStatus],
  );

  const open = async (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    setDoc(null);
    setPdf(null);
    if (ext === "xlsx" || ext === "xls") {
      setFile(null);
      setWorkbook(null);
      setSheetIndex(0);
      const res = (await window.pi
        .readTable(cwd, path)
        .catch((e) => ({ ok: false, error: String(e) }))) as {
        ok: boolean;
        sheets?: { name: string; rows: string[][]; truncatedRows?: boolean }[];
        truncatedSheets?: boolean;
        error?: string;
      };
      if (res.ok && res.sheets?.length) {
        setWorkbook({ path, sheets: res.sheets, truncatedSheets: res.truncatedSheets });
      } else {
        setFile({ path, content: `无法预览表格：${res.error ?? "未知错误"}` });
      }
      return;
    }
    setWorkbook(null);
    if (ext === "docx") {
      setFile(null);
      const res = (await window.pi
        .readDoc(cwd, path)
        .catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; html?: string; error?: string };
      if (res.ok && res.html) {
        setDoc({ path, html: res.html });
      } else {
        setFile({ path, content: `无法预览文档：${res.error ?? "未知错误"}` });
      }
      return;
    }
    if (ext === "pdf") {
      setFile(null);
      const res = (await window.pi
        .readPdf(cwd, path)
        .catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; data?: Uint8Array; error?: string };
      if (res.ok && res.data) {
        setPdf({ path, data: res.data });
      } else {
        setFile({ path, content: `无法预览 PDF：${res.error ?? "未知错误"}` });
      }
      return;
    }
    const res = await window.pi.readFile(cwd, path);
    setFile({ path, content: res.content ?? res.error ?? "" });
  };

  if (doc) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button className="h-6 px-1.5" onClick={() => setDoc(null)} size="sm" variant="ghost">
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="truncate font-mono text-[11px]">{doc.path}</span>
        </div>
        {/* mammoth 输出的干净 HTML（无脚本），prose 样式渲染 */}
        <div
          className="doc-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
      </div>
    );
  }

  if (pdf) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button
            className="h-6 px-1.5"
            onClick={() => {
              setPdf(null);
            }}
            size="sm"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="truncate font-mono text-[11px]">{pdf.path}</span>
        </div>
        <PdfView data={pdf.data} />
      </div>
    );
  }

  if (workbook) {
    const sheet = workbook.sheets[Math.min(sheetIndex, workbook.sheets.length - 1)];
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button
            className="h-6 px-1.5"
            onClick={() => {
              setWorkbook(null);
              setSheetIndex(0);
            }}
            size="sm"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="truncate font-mono text-[11px]">{workbook.path}</span>
        </div>
        {workbook.sheets.length > 1 ? (
          <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b px-1 py-1">
            {workbook.sheets.map((s, i) => (
              <button
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent/60",
                  i === sheetIndex ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
                )}
                key={s.name}
                onClick={() => setSheetIndex(i)}
                type="button"
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {sheet ? (
            <TableGrid
              dark={dark}
              note={
                sheet.truncatedRows
                  ? "行数较多，仅显示前 2000 行"
                  : workbook.truncatedSheets
                    ? "工作表较多，仅显示前 30 个"
                    : undefined
              }
              rows={sheet.rows}
            />
          ) : null}
        </div>
      </div>
    );
  }

  if (file) {
    const ext = (file.path.split(".").pop() ?? "").toLowerCase();
    const isTable = ext === "csv" || ext === "tsv";
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button className="h-6 px-1.5" onClick={() => setFile(null)} size="sm" variant="ghost">
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="truncate font-mono text-[11px]">{file.path}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {isTable ? (
            <DelimitedTable content={file.content} dark={dark} delimiter={ext === "tsv" ? "\t" : ","} />
          ) : (
            <CodeBlock code={file.content} language={(LANGS[ext] ?? "text") as BundledLanguage}>
              <CodeBlockCopyButton />
            </CodeBlock>
          )}
        </div>
      </div>
    );
  }

  const renderRows = (dir: string, depth: number): React.ReactNode => {
    const entries = children[dir];
    if (!entries) {
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> 加载中…
        </div>
      );
    }
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const status = statusOf(entry.path, entry.dir);
      const dimmed = entry.dir && DIMMED_DIRS.has(entry.name);
      return (
        <div key={entry.path}>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-[12px] hover:bg-accent/50"
            onClick={() => (entry.dir ? toggle(entry.path) : void open(entry.path))}
            style={{ paddingLeft: 6 + depth * 14 }}
            type="button"
          >
            {entry.dir ? (
              isOpen ? (
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/70" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {entry.dir ? null : iconFor(entry.name)}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                entry.dir && "font-medium",
                dimmed && "text-muted-foreground/60",
                !dimmed && status === "modified" && "text-amber-500",
                !dimmed && status === "untracked" && "text-emerald-500",
              )}
            >
              {entry.name}
            </span>
            <StatusDot status={status} />
          </button>
          {entry.dir && isOpen ? renderRows(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-0.5 px-2 pb-1">
        <button
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] transition-colors",
            tab === "changes"
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/40",
          )}
          onClick={() => setTab("changes")}
          type="button"
        >
          改动{changes?.length ? ` (${changes.length})` : ""}
        </button>
        <button
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] transition-colors",
            tab === "tree"
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/40",
          )}
          onClick={() => setTab("tree")}
          type="button"
        >
          文件树
        </button>
      </div>
      {tab === "changes" ? (
        <ChangesPanel changes={changes} cwd={cwd} onReverted={refresh} />
      ) : null}
      {tab === "tree" ? (
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-2 pb-1">
        <div className="flex h-8 items-center gap-1.5 rounded-md border bg-muted/30 px-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件…"
            value={query}
          />
          {query ? (
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
              type="button"
            >
              清除
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted-foreground">
          {baseName(cwd)}
        </span>
        <Button
          className="size-6 shrink-0 text-muted-foreground"
          onClick={refresh}
          size="icon-sm"
          title="刷新"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {query.trim() ? (
          results.length ? (
            results.map((path) => {
              const slash = path.lastIndexOf("/");
              return (
                <button
                  className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-[12px] hover:bg-accent/50"
                  key={path}
                  onClick={() => void open(path)}
                  type="button"
                >
                  {iconFor(path)}
                  <span className="min-w-0 truncate font-mono">
                    <span className="text-muted-foreground">{slash >= 0 ? path.slice(0, slash + 1) : ""}</span>
                    {slash >= 0 ? path.slice(slash + 1) : path}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">没有匹配的文件</p>
          )
        ) : (
          renderRows("", 0)
        )}
      </div>
      </div>
      ) : null}
    </div>
  );
}

/** CSV/TSV preview, the way ZCode's preview panel renders spreadsheets. */
/** 表格网格（AG Grid Community）：虚拟滚动、列宽拖拽、排序、quick filter。
 * xlsx sheet 和 csv/tsv 文本共用。主题参数跟随应用深浅色。 */
function TableGrid({ rows, note, dark }: { rows: string[][]; note?: string; dark: boolean }) {
  const [q, setQ] = useState("");
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
      })),
    [maxCols, head],
  );
  const rowData = useMemo(
    () => body.map((row) => Object.fromEntries(Array.from({ length: maxCols }, (_, c) => [`c${c}`, row[c] ?? ""]))),
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <div className="flex h-6 items-center gap-1.5 rounded border bg-muted/30 px-2">
          <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="w-36 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选行…"
            value={q}
          />
        </div>
        <span className="text-[10px] text-muted-foreground">
          {rows.length - 1} 行 × {maxCols} 列
        </span>
        {note ? <span className="text-[10px] text-amber-500/80">{note}</span> : null}
        <Button
          className="ml-auto h-6 px-1.5 text-[11px]"
          onClick={() => void navigator.clipboard.writeText(rows.map((r) => r.join(",")).join("\n"))}
          size="sm"
          variant="ghost"
        >
          复制为 CSV
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact
          columnDefs={columnDefs}
          onGridReady={(e) => {
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

// pdf.js 的类型对外很难引用，简单包一层
type PdfDoc = Awaited<ReturnType<typeof getDocument>["promise"]>;
const loadPdf = async (data: Uint8Array): Promise<PdfDoc> => {
  const task = getDocument({ data });
  task.onPassword = () => {
    throw new Error("加密 PDF 暂不支持预览");
  };
  return task.promise;
};

/** PDF 预览：pdf.js 逐页渲染 canvas + 翻页。 */
function PdfView({ data }: { data: Uint8Array }) {
  const [doc, setDoc] = useState<Awaited<ReturnType<typeof loadPdf>> | null>(null);
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
      <div className="flex shrink-0 items-center justify-center gap-2 border-b px-2 py-1">
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

function DelimitedTable({
  content,
  delimiter,
  dark,
}: {
  content: string;
  delimiter: string;
  dark: boolean;
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
