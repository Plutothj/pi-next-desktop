// 应用内确认框：用它替代 window.confirm（系统原生弹框和我们的暗色 UI
// 完全不同，还会在某些平台上被拦截）。用法：
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "删除？", destructive: true }))) return;
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(
  async () => false,
);

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const settle = useCallback((ok: boolean) => {
    setPending((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog onOpenChange={(v: boolean) => !v && settle(false)} open={Boolean(pending)}>
        <DialogContent className="max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">{pending?.title ?? ""}</DialogTitle>
            {pending?.description ? (
              <DialogDescription className="whitespace-pre-line text-xs leading-5">
                {pending.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              autoFocus={Boolean(pending?.destructive)}
              className="h-8"
              onClick={() => settle(false)}
              size="sm"
              variant="ghost"
            >
              {pending?.cancelText ?? "取消"}
            </Button>
            <Button
              autoFocus={!pending?.destructive}
              className="h-8"
              onClick={() => settle(true)}
              size="sm"
              variant={pending?.destructive ? "destructive" : "default"}
            >
              {pending?.confirmText ?? "确定"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
