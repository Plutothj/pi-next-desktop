import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, FileIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { baseName, cn } from "@/lib/utils";
import type { TreeEntry } from "@/lib/pi";

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json",
  md: "markdown", css: "css", html: "html", py: "python", rs: "rust",
  go: "go", sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql",
};

export function FilesPanel({ cwd }: { cwd: string }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setEntries(await window.pi.tree(cwd, target));
      setLoading(false);
      setDir(target);
    },
    [cwd],
  );

  useEffect(() => {
    setFile(null);
    load("");
  }, [load, cwd]);

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
            <CodeBlock code={file.content} language={LANGS[ext] ?? "text"}>
              <CodeBlockCopyButton />
            </CodeBlock>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {dir ? (
          <Button
            className="h-6 px-1.5"
            onClick={() => load(dir.split("/").slice(0, -1).join("/"))}
            size="sm"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
        ) : null}
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {dir || baseName(cwd)}
        </span>
        {loading ? <Loader2Icon className="size-3 animate-spin" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entries.map((entry) => (
          <button
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/60"
            key={entry.path}
            onClick={() => (entry.dir ? load(entry.path) : open(entry.path))}
            type="button"
          >
            {entry.dir ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("truncate font-mono text-[11px]")}>{entry.name}</span>
          </button>
        ))}
        {!entries.length && !loading ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">空目录</p>
        ) : null}
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
