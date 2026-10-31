import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { UiDialogRequest } from "@/lib/pi";

/**
 * Blocking dialogs raised by pi extensions (ctx.ui.select / input / editor).
 * Rendered as a card anchored above the composer (like ZCode), not a centered
 * modal. pi waits on the response, so every path — including Escape — answers.
 */
export function ExtensionDialog({
  dialog,
  onRespond,
}: {
  dialog: UiDialogRequest | null;
  onRespond: (
    dialog: UiDialogRequest,
    values: { value?: string; cancelled?: boolean },
  ) => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!dialog) return;
    setText(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  }, [dialog]);

  const cancel = () => {
    if (dialog) onRespond(dialog, { cancelled: true });
  };
  const confirm = (value?: string) => {
    if (!dialog) return;
    onRespond(dialog, { value: dialog.method === "select" ? value : text });
  };

  // Escape works even if focus has moved elsewhere.
  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!dialog) return null;

  return (
    <div
      aria-label={dialog.title ?? "Pi 扩展请求"}
      aria-modal="false"
      className="absolute right-0 bottom-full left-0 z-30 mb-2 animate-in overflow-hidden rounded-xl border bg-popover shadow-lg fade-in-0 slide-in-from-bottom-2"
      role="dialog"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {dialog.title ?? "Pi 扩展请求"}
        </span>
        <Button className="h-6 px-1.5 text-[11px]" onClick={cancel} size="sm" variant="ghost">
          取消
        </Button>
      </div>

      {dialog.method === "select" ? (
        <div className="flex max-h-64 flex-col gap-0.5 overflow-auto p-1.5">
          {(dialog.options ?? []).map((option) => (
            <button
              className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              key={option}
              onClick={() => confirm(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {dialog.method === "input" ? (
        <div className="p-1.5">
          <Input
            autoFocus
            className="h-8 text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
            placeholder={dialog.placeholder ?? ""}
            value={text}
          />
        </div>
      ) : null}

      {dialog.method === "editor" ? (
        <div className="p-1.5">
          <Textarea
            autoFocus
            className="min-h-40 resize-none font-mono text-xs"
            onChange={(e) => setText(e.target.value)}
            value={text}
          />
        </div>
      ) : null}

      {dialog.method === "select" ? null : (
        <div className="flex justify-end border-t px-2 py-1.5">
          <Button className="h-7 px-3 text-xs" onClick={() => confirm()} size="sm">
            确认
          </Button>
        </div>
      )}
    </div>
  );
}
