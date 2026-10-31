import { useMemo } from "react";
import { diffLines } from "diff";
import { FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Edit = { oldText?: string; newText?: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Pull the file path plus old/new pairs out of an edit-style tool call. */
export function editsOf(args: Record<string, unknown> | undefined) {
  if (!args) return null;
  const filePath = str(args.path) || str(args.file_path) || str(args.filePath);
  const raw = Array.isArray(args.edits) ? (args.edits as Edit[]) : null;
  const pairs = raw?.length
    ? raw.map((e) => ({ oldText: str(e?.oldText), newText: str(e?.newText) }))
    : args.oldText !== undefined || args.newText !== undefined
      ? [{ oldText: str(args.oldText), newText: str(args.newText) }]
      : [];
  if (pairs.length) return { path: filePath, pairs, created: false };

  // `write` replaces the whole file.
  if (filePath && typeof args.content === "string") {
    return { path: filePath, pairs: [{ oldText: "", newText: args.content }], created: true };
  }
  return null;
}

type Row = { kind: "add" | "del" | "ctx"; text: string; no: number | null };

function rowsFor(oldText: string, newText: string): Row[] {
  const parts = diffLines(oldText, newText);
  const rows: Row[] = [];
  let line = 1;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) {
      if (part.added) rows.push({ kind: "add", text, no: null });
      else if (part.removed) rows.push({ kind: "del", text, no: line++ });
      else {
        rows.push({ kind: "ctx", text, no: line++ });
      }
    }
  }
  return rows;
}

export function FileDiff({
  path,
  pairs,
  created,
}: {
  path: string;
  pairs: { oldText: string; newText: string }[];
  created?: boolean;
}) {
  const hunks = useMemo(() => pairs.map((p) => rowsFor(p.oldText, p.newText)), [pairs]);
  const added = hunks.flat().filter((r) => r.kind === "add").length;
  const removed = hunks.flat().filter((r) => r.kind === "del").length;

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs">
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{path || "文件"}</span>
        <span className="ml-auto shrink-0 font-mono">
          {added > 0 ? <span className="text-emerald-500">+{added}</span> : null}{" "}
          {removed > 0 ? <span className="text-rose-500">-{removed}</span> : null}
        </span>
      </div>
      <div className="max-h-96 overflow-auto font-mono text-xs leading-5">
        {hunks.map((rows, h) => (
          <div key={h} className={cn(h > 0 && "border-t")}>
            {created && h === 0 ? (
              <div className="px-3 py-1 text-muted-foreground text-xs">新建文件</div>
            ) : null}
            {rows.map((row, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-2 px-2",
                  row.kind === "add" && "bg-emerald-500/10",
                  row.kind === "del" && "bg-rose-500/10",
                )}
              >
                <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                  {row.no ?? ""}
                </span>
                <span
                  className={cn(
                    "w-2 shrink-0 select-none",
                    row.kind === "add" && "text-emerald-500",
                    row.kind === "del" && "text-rose-500",
                  )}
                >
                  {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap break-all">{row.text || " "}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
