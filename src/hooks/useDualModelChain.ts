import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import type { ModelInfo } from "@/lib/pi";
import type { State } from "@/hooks/usePi";
import type { useDualModel } from "@/hooks/useDualModel";

// Dual-model chain directives. The planner runs read-only; the executor picks
// up the same conversation once the planning turn settles.
const DUAL_PLAN_PREFIX =
  "【规划阶段】只做分析与方案：不要修改任何文件，也不要执行会改变状态的命令。请给出分步骤实施方案，具体到要改的文件/函数/命令，并说明每步如何验证。完成后停下，等待执行阶段。\n\n";
const DUAL_EXEC_PREFIX =
  "【执行阶段】请按上面确定的方案开始实施。逐项完成并验证；如果实际情况与方案不符，做最小必要调整，并在最终回复中说明偏差。";

type Phase = "idle" | "planning" | "executing";

type PromptFn = (
  text: string,
  files?: FileUIPart[],
  behavior?: "steer" | "followUp",
) => Promise<unknown>;

/**
 * Orchestrates the plan→execute chain: a fresh task runs the planner
 * read-only, then switches to the executor once planning settles and restores
 * the user's model afterwards. Stopping aborts the chain; switching sessions
 * cancels it without touching the new session's model.
 */
export function useDualModelChain({
  dual,
  state,
  switchModel,
  prompt,
  send,
}: {
  dual: ReturnType<typeof useDualModel>;
  state: State;
  switchModel: (model: ModelInfo) => Promise<unknown>;
  prompt: PromptFn;
  send: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const chainRef = useRef<{
    phase: Phase;
    started: boolean;
    original?: ModelInfo;
    sessionFile?: string;
  }>({ phase: "idle", started: false });

  // Ends the chain; restores the user's model unless aborted by a session
  // switch (where the model belongs to the new session).
  const reset = useCallback(
    async (restore = true) => {
      const chain = chainRef.current;
      chainRef.current = { phase: "idle", started: false };
      setPhase("idle");
      if (restore && chain.original) await switchModel(chain.original);
    },
    [switchModel],
  );

  const start = useCallback(
    async (text: string, files: FileUIPart[] | undefined, planner: ModelInfo) => {
      chainRef.current = {
        phase: "planning",
        started: false,
        original: state.model,
        sessionFile: state.sessionFile,
      };
      setPhase("planning");
      const switched = await switchModel(planner);
      if (!switched) {
        await reset();
        return;
      }
      const res = await prompt(DUAL_PLAN_PREFIX + text, files, "followUp");
      if (!res) await reset();
      // The executor is looked up again when planning settles (config may change).
    },
    [state.model, state.sessionFile, switchModel, prompt, reset],
  );

  // Advance the chain when a phase's run settles.
  useEffect(() => {
    const chain = chainRef.current;
    if (chain.phase === "idle") return;
    if (state.isStreaming) {
      chain.started = true;
      return;
    }
    if (!chain.started) return;
    if (chain.sessionFile !== state.sessionFile) {
      reset(false);
      return;
    }
    if (chain.phase === "planning") {
      const executor = dual.find(state.models, dual.config.executor);
      if (!executor) {
        reset();
        return;
      }
      chain.phase = "executing";
      chain.started = false;
      setPhase("executing");
      void (async () => {
        const switched = await switchModel(executor);
        if (!switched) {
          await reset();
          return;
        }
        const res = await prompt(DUAL_EXEC_PREFIX, undefined, "followUp");
        if (!res) await reset();
      })();
    } else {
      reset();
    }
  }, [
    state.isStreaming,
    state.sessionFile,
    state.models,
    dual.config,
    dual.find,
    switchModel,
    prompt,
    reset,
  ]);

  const stopAll = useCallback(() => {
    if (chainRef.current.phase !== "idle") reset();
    send({ type: "abort" });
  }, [reset, send]);

  return { phase, start, reset, stopAll };
}
