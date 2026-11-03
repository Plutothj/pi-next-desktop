// 会话树可视化：pi 的 get_tree 数据画成缩进树，当前活动路径高亮，
// 任意节点可「从这里重走」（fork）——pi 的会话本来就是 append-only 树，
// 这里只是让它可见。
import { useCallback, useEffect, useState } from "react";
import { GitForkIcon, Loader2Icon, MessageSquareIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { stripDirective } from "@/lib/promptPrefixes";

type TreeNode = {
  entry: {
    type: string;
    id: string;
    parentId: string | null;
    label?: string;
    message?: { role: string; content: string | { type: string; text?: string }[] };
  };
  children: TreeNode[];
  label?: string;
};

const nodeText = (node: TreeNode): string => {
  const m = node.entry.message;
  if (!m) return node.label ?? node.entry.type;
  const raw =
    typeof m.content === "string"
      ? m.content
      : (m.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ");
  const text = stripDirective(raw).text.replace(/\s+/g, " ").trim();
  if (!text) return m.role === "user" ? "（附件/图片）" : "（无文本）";
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
};

export function SessionTreePanel({
  sessionFile,
  onForkEntry,
}: {
  sessionFile: string | undefined;
  onForkEntry: (entryId: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!sessionFile) return;
    setLoading(true);
    const res = (await window.pi
      .send({ type: "get_tree" })
      .catch(() => null)) as { tree?: TreeNode[]; leafId?: string } | null;
    setLoading(false);
    if (res?.tree) {
      setTree(res.tree);
      setLeafId(res.leafId ?? null);
    }
  }, [sessionFile]);

  useEffect(() => {
    load();
  }, [load]);

  // 活动路径：从 leaf 沿 parentId 回溯
  const activePath = (() => {
    if (!tree || !leafId) return new Set<string>();
    const byId = new Map<string, TreeNode>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        byId.set(n.entry.id, n);
        walk(n.children);
      }
    };
    walk(tree);
    const path = new Set<string>();
    let cur = byId.get(leafId);
    while (cur) {
      path.add(cur.entry.id);
      cur = cur.entry.parentId ? byId.get(cur.entry.parentId) : undefined;
    }
    return path;
  })();

  const countNodes = (nodes: TreeNode[]): number =>
    nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const isActive = activePath.has(node.entry.id);
      const isUser = node.entry.message?.role === "user";
      const isLeaf = node.entry.id === leafId;
      return (
        <div key={node.entry.id}>
          <button
            className={cn(
              "group/tree flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11px]",
              isActive ? "text-foreground" : "text-muted-foreground/70 hover:text-muted-foreground",
            )}
            onClick={() => onForkEntry(node.entry.id)}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            title={`${nodeText(node)}\n点击从这里重走（fork，原分支保留）`}
            type="button"
          >
            {isUser ? (
              <MessageSquareIcon className="size-3 shrink-0" />
            ) : (
              <WrenchIcon className="size-3 shrink-0 opacity-60" />
            )}
            <span className={cn("min-w-0 flex-1 truncate", isLeaf && "font-medium")}>
              {nodeText(node)}
            </span>
            {isLeaf ? <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" /> : null}
            <GitForkIcon className="size-3 shrink-0 opacity-0 transition group-hover/tree:opacity-60" />
          </button>
          {node.children.length > 0 ? renderNodes(node.children, depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <span className="flex-1">
          会话树
          {tree ? `（${countNodes(tree)} 个节点）` : ""}
        </span>
        <Button className="h-6 w-6 p-0" onClick={load} size="sm" variant="ghost">
          {loading ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <GitForkIcon className="size-3" />
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!sessionFile ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">还没有活动会话</p>
        ) : tree && tree.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">会话为空</p>
        ) : null}
        {tree ? renderNodes(tree, 0) : null}
      </div>
      <p className="pt-2 text-[10px] leading-4 text-muted-foreground/60">
        点任意节点从那里重走；原分支保留在树里，随时可以回来。
      </p>
    </div>
  );
}
