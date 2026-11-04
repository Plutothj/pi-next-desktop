import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { AskAiButton, DelimitedTable, DocView, PdfView, TableGrid } from "@/components/preview-views";

import {
  BracesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FolderOpenIcon,
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
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { ChangesPanel } from "@/components/changes-panel";
import { Button } from "@/components/ui/button";
import type { GitStatus, TreeEntry } from "@/lib/pi";
import { baseName, cn } from "@/lib/utils";


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
  onAskAi,
  previewRequest,
  refreshToken,
}: {
  cwd: string;
  changes?: GitStatus["changes"];
  dark?: boolean;
  onAskAi?: (prompt: string) => void;
  // 聊天附件 chip 点开：{abs,name,seq} 每次请求递增 seq
  previewRequest?: { abs: string; name: string; seq: number } | null;
  // 每回合结束 +1：预览中的文件若被 AI 改写，自动重新读取
  refreshToken?: number;
}) {
  const [tab, setTab] = useState<"changes" | "tree">("changes");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [_loading, setLoading] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [file, setFile] = useState<{ path: string; abs?: string; content: string } | null>(null);
  // xlsx/xls 结构化预览（多 sheet）
  const [workbook, setWorkbook] = useState<{
    path: string;
    abs?: string;
    sheets: { name: string; rows: string[][]; truncatedRows?: boolean }[];
    truncatedSheets?: boolean;
  } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  // 表格编辑：脏标记 / 保存中 / 最近错误；saveSnapshot 由 TableGrid 注入
  const [sheetDirty, setSheetDirty] = useState(false);
  const [savingSheet, setSavingSheet] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveSnapshot = useRef<(() => string[][]) | undefined>(undefined);
  // docx → HTML 预览
  const [doc, setDoc] = useState<{ path: string; abs?: string; html: string } | null>(null);
  // pdf → 渲染层 pdf.js 预览
  const [pdf, setPdf] = useState<{ path: string; abs?: string; data: Uint8Array } | null>(null);

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

  const open = async (path: string, abs?: string) => {
    const ext = (abs ?? path).split(".").pop()?.toLowerCase() ?? "";
    setDoc(null);
    setPdf(null);
    if (ext === "xlsx" || ext === "xls") {
      setFile(null);
      setWorkbook(null);
      setSheetIndex(0);
      const res = (await window.pi
        .readTable(cwd, path, abs)
        .catch((e) => ({ ok: false, error: String(e) }))) as {
        ok: boolean;
        sheets?: { name: string; rows: string[][]; truncatedRows?: boolean }[];
        truncatedSheets?: boolean;
        error?: string;
      };
      if (res.ok && res.sheets?.length) {
        setWorkbook({ path, abs, sheets: res.sheets, truncatedSheets: res.truncatedSheets });
      } else {
        setFile({ path, abs, content: `无法预览表格：${res.error ?? "未知错误"}` });
      }
      return;
    }
    setWorkbook(null);
    if (ext === "docx") {
      setFile(null);
      const res = (await window.pi
        .readDoc(cwd, path, abs)
        .catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; html?: string; error?: string };
      if (res.ok && res.html) {
        setDoc({ path, abs, html: res.html });
      } else {
        setFile({ path, abs, content: `无法预览文档：${res.error ?? "未知错误"}` });
      }
      return;
    }
    if (ext === "pdf") {
      setFile(null);
      const res = (await window.pi
        .readPdf(cwd, path, abs)
        .catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; data?: Uint8Array; error?: string };
      if (res.ok && res.data) {
        setPdf({ path, abs, data: res.data });
      } else {
        setFile({ path, abs, content: `无法预览 PDF：${res.error ?? "未知错误"}` });
      }
      return;
    }
    const res = await window.pi.readFile(cwd, path, abs);
    setFile({ path, abs, content: res.content ?? res.error ?? "" });
  };

  // 聊天附件 chip：收到请求就打开该绝对路径文件（预览面板直接展示）
  const lastPreviewSeq = useRef(0);
  useEffect(() => {
    if (!previewRequest?.abs || previewRequest.seq === lastPreviewSeq.current) return;
    lastPreviewSeq.current = previewRequest.seq;
    void open(previewRequest.abs, previewRequest.abs);
  }, [previewRequest, open]);

  // 当前预览的路径（自动刷新用）
  const currentPreview = file ?? workbook ?? doc ?? pdf;
  const currentPath = currentPreview?.path ?? null;
  const lastRefresh = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (refreshToken === undefined) return;
    if (lastRefresh.current === undefined) {
      lastRefresh.current = refreshToken;
      return;
    }
    if (lastRefresh.current === refreshToken || !currentPath) return;
    lastRefresh.current = refreshToken;
    void open(currentPath, currentPreview?.abs);
    // open 依赖 cwd/setState，闭包已是最新；effect 只在 token 变化时跑，不必追依赖
  }, [refreshToken, currentPath, open]);

  if (doc) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Button className="h-6 px-1.5" onClick={() => setDoc(null)} size="sm" variant="ghost">
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="truncate font-mono text-[11px]">{doc.path}</span>
          {onAskAi ? <AskAiButton abs={doc.abs} cwd={cwd} onAsk={(text) => onAskAi(text)} path={doc.path} /> : null}
        </div>
        <DocView html={doc.html} />
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
          {onAskAi ? <AskAiButton abs={pdf.abs} cwd={cwd} onAsk={(text) => onAskAi(text)} path={pdf.path} /> : null}
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
          {onAskAi ? <AskAiButton abs={workbook.abs} cwd={cwd} onAsk={(text) => onAskAi(text)} path={workbook.path} sheets={workbook.sheets.map((s) => s.name)} /> : null}
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
              editable
              note={
                sheet.truncatedRows
                  ? "行数较多，仅显示前 2000 行（改动请另存副本）"
                  : workbook.truncatedSheets
                    ? "工作表较多，仅显示前 30 个"
                    : undefined
              }
              onDirtyChange={setSheetDirty}
              snapshotRef={saveSnapshot}
              rows={sheet.rows}
            />
          ) : null}
          {sheetDirty ? (
            <div className="flex shrink-0 items-center gap-2 border-t bg-amber-500/10 px-2 py-1.5">
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                单元格已修改（保存会重写该工作表，公式按 = 开头识别）
              </span>
              <Button
                className="ml-auto h-6 px-2 text-[11px]"
                disabled={savingSheet}
                onClick={async () => {
                  const rowsNow = saveSnapshot.current?.();
                  if (!rowsNow || !sheet) return;
                  setSavingSheet(true);
                  const res = await window.pi
                    .writeTable(cwd, workbook.path, workbook.abs, sheet.name, rowsNow)
                    .catch((e) => ({ ok: false, error: String(e) }));
                  setSavingSheet(false);
                  if (!res.ok) {
                    setSaveError(res.error ?? "保存失败");
                    return;
                  }
                  setSaveError(null);
                  setSheetDirty(false);
                  // 重新载入以显示公式计算后的结构
                  void open(workbook.path, workbook.abs);
                }}
                size="sm"
              >
                {savingSheet ? "保存中…" : "保存到 xlsx"}
              </Button>
              <Button
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setSheetDirty(false);
                  void open(workbook.path, workbook.abs);
                }}
                size="sm"
                variant="ghost"
              >
                放弃改动
              </Button>
            </div>
          ) : null}
          {saveError ? (
            <p className="shrink-0 border-t px-2 py-1 text-[11px] text-destructive">{saveError}</p>
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
          onClick={async () => {
            // 工作区外的文件（下载/微信接收）：系统选择器挑一个，直接预览
            const picked = await window.pi.pickPreview().catch(() => null);
            if (picked?.ok && picked.path) void open(picked.path, picked.path);
          }}
          size="icon-sm"
          title="打开工作区外的文件（xlsx / docx / pdf / csv…）"
          variant="ghost"
        >
          <FolderOpenIcon className="size-3.5" />
        </Button>
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
