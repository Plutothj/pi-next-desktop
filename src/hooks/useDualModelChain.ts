import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { DUAL_EXEC_PREFIX } from "@/lib/promptPrefixes";
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
    planTouched?: boolean;
  }>({ phase: "idle", started: false });

  // Ends the chain; restores the user's model unless aborted by a session
  // switch (where the model belongs to the new session). keepPlan 用于计划被
  // 用户拒绝的场景：保持计划模式，让用户继续修改方案。
  const reset = useCallback(
    async (restore = true, keepPlan = false) => {
      const chain = chainRef.current;
      chainRef.current = { phase: "idle", started: false };
      setPhase("idle");
      if (!keepPlan && chain.planTouched && chain.sessionFile) {
        await window.pi.setPlanMode(chain.sessionFile, false, false).catch(() => null);
      }
      if (restore && chain.original) await switchModel(chain.original);
    },
    [switchModel],
  );

  const start = useCallback(
    async (text: string, files: FileUIPart[] | undefined, planner: ModelInfo) => {
      const file = state.sessionFile;
      let planTouched = false;
      // 规划阶段用真正的计划模式：只读工具闸门 + 系统提示要求用 ExitPlanMode
      // 交计划。autoApprove 仅当用户没手动开计划模式时启用（双模型是自动链路）。
      if (file) {
        const before = await window.pi.getPlanMode(file).catch(() => null);
        const autoApprove = !before?.enabled;
        const applied = await window.pi.setPlanMode(file, true, autoApprove, true).catch(() => null);
        planTouched = Boolean(applied?.ok);
      }
      chainRef.current = {
        phase: "planning",
        started: false,
        original: state.model,
        sessionFile: file,
        planTouched,
      };
      setPhase("planning");
      const switched = await switchModel(planner);
      if (!switched) {
        await reset();
        return;
      }
      // 不再往用户消息里拼"规划阶段"话术：约束来自 plan-mode 扩展。
      const res = await prompt(text, files, "followUp");
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
      // 规划模型提交的计划被用户拒绝：保持计划模式，恢复原模型，不进入执行。
      const planResult = [...state.messages]
        .reverse()
        .find((m) => m.role === "toolResult" && m.toolName === "ExitPlanMode");
      if (planResult?.isError) {
        void reset(true, true);
        return;
      }

      chain.phase = "executing";
      chain.started = false;
      setPhase("executing");
      void (async () => {
        const details = planResult?.details as { plan?: string; planFile?: string } | undefined;
        let planFile = details?.planFile ?? "";
        if (!planFile) {
          // 规划模型没用 ExitPlanMode：把最后一段正文落成文档做兜底。
          const planText = details?.plan || lastAssistantTextOf(state.messages);
          const saved = planText
            ? await window.pi.plans
                .save(state.cwd, `# 执行方案\n\n${planText}\n`)
                .catch(() => null)
            : null;
          if (saved?.ok && saved.path) planFile = saved.path;
        }
        if (!planFile) {
          await reset();
          return;
        }
        // 关闭规划闸门后执行模型才能写文件 / 跑命令。
        if (chain.sessionFile) {
          await window.pi.setPlanMode(chain.sessionFile, false, false).catch(() => null);
        }
        const directive = `${DUAL_EXEC_PREFIX}\n方案文档：${planFile}（开始前先读取该文件，按它逐项实施）。`;
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
