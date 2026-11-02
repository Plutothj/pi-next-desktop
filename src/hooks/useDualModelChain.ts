import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { DUAL_EXEC_PREFIX, DUAL_PLAN_PREFIX } from "@/lib/promptPrefixes";
import { lastAssistantTextOf, type ModelInfo } from "@/lib/pi";
import type { State } from "@/hooks/usePi";
import type { useDualModel } from "@/hooks/useDualModel";

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
        // Persist the plan into the project so it survives the session and the
        // executor works from a stable document (like ZCode's .zcode/plans).
        const planText = lastAssistantTextOf(state.messages);
        const saved = planText
          ? await window.pi.plans
              .save(state.cwd, `# 执行方案\n\n${planText}\n`)
              .catch(() => null)
          : null;
        const directive =
          saved?.ok && saved.path
            ? `${DUAL_EXEC_PREFIX}\n方案文档：${saved.path}（开始前先读取该文件，按它逐项实施）。`
            : DUAL_EXEC_PREFIX;
        const switched = await switchModel(executor);
        if (!switched) {
          await reset();
          return;
        }
        const res = await prompt(directive, undefined, "followUp");
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
    reset, state.messages, state.cwd
  ]);

  const stopAll = useCallback(() => {
    if (chainRef.current.phase !== "idle") reset();
    send({ type: "abort" });
  }, [reset, send]);

  return { phase, start, reset, stopAll };
}
