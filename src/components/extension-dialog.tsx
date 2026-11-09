import { useEffect, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
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
    values: { value?: string; cancelled?: boolean; confirmed?: boolean },
  ) => void;
}) {
  const [text, setText] = useState("");
  // select 里选中"其他/Other"类选项时，切成输入框让用户写自由答案
  const [freeform, setFreeform] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    setText(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
    setFreeform(false);
  }, [dialog]);

  const cancel = () => {
    if (dialog) onRespond(dialog, { cancelled: true });
  };
  const confirm = (value?: string) => {
    if (!dialog) return;
    if (dialog.method === "select") {
      onRespond(dialog, { value: freeform ? text : value });
      return;
    }
    onRespond(dialog, { value: text });
  };

  // "其他 / Other / 自定义" 这类兜底选项：改为自由输入，而不是回传字面量
  const isOtherOption = (option: string) =>
    /^(其他|其它|other|custom|自定义|手动输入)/i.test(option.trim());

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

      {dialog.method === "select" && !freeform ? (
        <div className="flex max-h-64 flex-col gap-0.5 overflow-auto p-1.5">
          {(dialog.options ?? []).map((option) => (
            <button
              className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              key={option}
              onClick={() => {
                if (isOtherOption(option)) {
                  setFreeform(true);
                  return;
                }
                confirm(option);
              }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {dialog.method === "select" && freeform ? (
        <div className="p-1.5">
          <Input
            autoFocus
            className="h-8 text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && text.trim() && confirm()}
            placeholder="输入你的答案…"
            value={text}
          />
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

      {dialog.method === "confirm" ? (
        <div className="max-h-[45vh] overflow-auto border-b px-3 py-2" data-plan-approval>
          <MessageResponse className="chat-md text-xs">{dialog.message ?? ""}</MessageResponse>
        </div>
      ) : null}

      {dialog.method === "confirm" ? (
        <div className="flex justify-end gap-1.5 px-2 py-1.5">
          <Button
            className="h-7 px-3 text-xs"
            onClick={() => onRespond(dialog, { confirmed: false })}
            size="sm"
            variant="ghost"
          >
            拒绝
          </Button>
          <Button
            className="h-7 px-3 text-xs"
            onClick={() => onRespond(dialog, { confirmed: true })}
            size="sm"
          >
            批准并开始实施
          </Button>
        </div>
      ) : dialog.method === "select" && !freeform ? null : (
        <div className="flex justify-end border-t px-2 py-1.5">
          <Button
            className="h-7 px-3 text-xs"
            disabled={freeform && !text.trim()}
            onClick={() => confirm()}
            size="sm"
          >
            确认
          </Button>
        </div>
      )}
    </div>
  );
}
