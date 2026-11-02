import { useCallback, useEffect, useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  BracesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
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

export function FilesPanel({ cwd, changes }: { cwd: string; changes?: GitStatus["changes"] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [_loading, setLoading] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);

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
    const res = await window.pi.readFile(cwd, path);
    setFile({ path, content: res.content ?? res.error ?? "" });
  };

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
            <DelimitedTable content={file.content} delimiter={ext === "tsv" ? "\t" : ","} />
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
  );
}

/** CSV/TSV preview, the way ZCode's preview panel renders spreadsheets. */
function DelimitedTable({ content, delimiter }: { content: string; delimiter: string }) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .slice(0, 500)
    .map((line) => line.split(delimiter));
  const [head, ...body] = rows;

  return (
    <div className="p-2">
      <Button
        className="mb-1 h-6 px-1.5 text-[11px]"
        onClick={() => void navigator.clipboard.writeText(rows.map((r) => r.join(",")).join("\n"))}
        size="sm"
        variant="ghost"
      >
        复制为 CSV
      </Button>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {head?.map((cell, i) => (
              <th className="border-b bg-muted/50 px-1.5 py-1 text-left font-medium" key={i}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="hover:bg-accent/40">
              {row.map((cell, c) => (
                <td className="border-b px-1.5 py-0.5 font-mono" key={c}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
