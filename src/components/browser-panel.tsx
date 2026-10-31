import { useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CrosshairIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Electron's <webview> is not in React's intrinsic element list.
const Webview = "webview" as unknown as React.FC<Record<string, unknown>>;

const PICKER = `(async () => new Promise((resolve) => {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #6366f1;background:rgba(99,102,241,.15);border-radius:4px;transition:all .08s";
  document.body.appendChild(box);
  const path = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const index = node.parentElement ? [...node.parentElement.children].indexOf(node) + 1 : 1;
      parts.unshift(tag + ":nth-child(" + index + ")");
    }
    return parts.join(" > ");
  };
  const move = (event) => {
    const el = event.target;
    if (!el || el === box) return;
    const rect = el.getBoundingClientRect();
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  };
  const done = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    box.remove();
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", done, true);
    resolve({
      selector: path(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().slice(0, 400),
    });
  };
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", done, true);
}))()`;

export function BrowserPanel({ cwd }: { cwd: string }) {
  const [url, setUrl] = useState("https://");
  const [input, setInput] = useState("https://");
  const [picked, setPicked] = useState<{ selector: string; text: string } | null>(null);
  const view = useRef<HTMLElement | null>(null);

  const go = () => {
    const next = /^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
    setUrl(next);
  };

  const call = (method: string) => {
    const node = view.current as unknown as {
      [key: string]: (() => void) | undefined;
    } | null;
    node?.[method]?.();
  };

  const pick = async () => {
    const node = view.current as unknown as
      | { executeJavaScript: (code: string) => Promise<unknown> }
      | null;
    if (!node) return;
    try {
      const result = (await node.executeJavaScript(PICKER)) as {
        selector: string;
        text: string;
      };
      setPicked(result);
    } catch {
      setPicked(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button onClick={() => call("goBack")} size="icon-sm" variant="ghost">
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button onClick={() => call("goForward")} size="icon-sm" variant="ghost">
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button onClick={() => call("reload")} size="icon-sm" variant="ghost">
          <RotateCwIcon className="size-3.5" />
        </Button>
        <Input
          className="h-7 flex-1 font-mono text-[11px]"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          placeholder="https://"
          value={input}
        />
        <Button onClick={pick} size="icon-sm" title="拾取页面元素" variant="ghost">
          <CrosshairIcon className="size-3.5" />
        </Button>
      </div>

      {picked ? (
        <div className="shrink-0 border-b bg-muted/40 px-2 py-1.5 text-[11px]">
          <div className="flex items-center gap-1">
            <code className="truncate text-muted-foreground">{picked.selector}</code>
            <Button
              className="ml-auto h-5 px-1"
              onClick={() => setPicked(null)}
              size="sm"
              variant="ghost"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <p className="mt-0.5 line-clamp-2 text-muted-foreground">{picked.text}</p>
        </div>
      ) : null}

      <Webview
        className="min-h-0 flex-1 bg-background"
        key={url}
        partition="persist:browser"
        ref={view}
        src={url}
        // The docs pages and localhost previews both need this to behave like a tab.
        allowpopups="true"
        style={{ display: "flex" }}
      />
      <p className="shrink-0 border-t px-2 py-1 font-mono text-[10px] text-muted-foreground">
        {cwd}
      </p>
    </div>
  );
}
