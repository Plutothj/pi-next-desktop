import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { DUAL_EXEC_PREFIX } from "@/lib/promptPrefixes";
import { lastAssistantTextOf, type ModelInfo, type PiMessage } from "@/lib/pi";
import type { State } from "@/hooks/usePi";

type Phase = "idle" | "planning" | "executing";

type PromptForFn = (
  sessionFile: string,
  text: string,
  files?: FileUIPart[],
  behavior?: "steer" | "followUp",
) => Promise<unknown>;

/**
 * Orchestrates the plan→execute chain inside ONE session. It uses targeted
 * prompts/model switches, so switching to another session (or changing that
 * session's dual-model setting) never redirects or cancels the chain.
 */
export function useDualModelChain({
  state,
  promptFor,
  switchModelFor,
  send,
}: {
  state: State;
  promptFor: PromptForFn;
  switchModelFor: (sessionFile: string, model: ModelInfo) => Promise<unknown>;
  send: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [chainSession, setChainSession] = useState<string | undefined>();
  const chainRef = useRef<{
    phase: Phase;
    started: boolean;
    settling?: boolean;
    original?: ModelInfo;
    sessionFile?: string;
    cwd?: string;
    planTouched?: boolean;
    executor?: ModelInfo;
  }>({ phase: "idle", started: false });

  // Ends the chain; restores the model on the chain's own session, not on
  // whichever session the user happens to be looking at now.
  const reset = useCallback(
    async (restore = true, keepPlan = false) => {
      const chain = chainRef.current;
      chainRef.current = { phase: "idle", started: false };
      setPhase("idle");
      setChainSession(undefined);
      if (!keepPlan && chain.planTouched && chain.sessionFile) {
        await window.pi.setPlanMode(chain.sessionFile, false, false).catch(() => null);
      }
      if (restore && chain.original && chain.sessionFile) {
        await switchModelFor(chain.sessionFile, chain.original);
      }
    },
    [switchModelFor],
  );

  const start = useCallback(
    async (
      text: string,
      files: FileUIPart[] | undefined,
      planner: ModelInfo,
      executor: ModelInfo,
    ) => {
      const file = state.sessionFile;
      if (!file) return;
      let planTouched = false;
      // 规划阶段用真正的计划模式：只读工具闸门 + 系统提示要求用 ExitPlanMode
      // 交计划。autoApprove 仅当用户没手动开计划模式时启用（双模型是自动链路）。
      const before = await window.pi.getPlanMode(file).catch(() => null);
      const autoApprove = !before?.enabled;
      const applied = await window.pi.setPlanMode(file, true, autoApprove, true).catch(() => null);
      planTouched = Boolean(applied?.ok);

      chainRef.current = {
        phase: "planning",
        started: false,
        original: state.model,
        sessionFile: file,
        cwd: state.cwd,
        planTouched,
        executor,
      };
      setPhase("planning");
      setChainSession(file);

      const switched = await switchModelFor(file, planner);
      if (!switched) {
        await reset();
        return;
      }
      // 不拼"规划阶段"话术：约束来自 plan-mode 扩展。
      const res = await promptFor(file, text, files, "followUp");
      if (!res) await reset();
    },
    [state.model, state.sessionFile, state.cwd, switchModelFor, promptFor, reset],
  );

  // Advance when the chain's own session settles, even while the user looks
  // at a different session (runningSessions carries background status).
  useEffect(() => {
    const chain = chainRef.current;
    if (chain.phase === "idle" || !chain.sessionFile) return;
    const file = chain.sessionFile;
    const running =
      Boolean(state.runningSessions[file]) || (state.sessionFile === file && state.isStreaming);
    if (running) {
      chain.started = true;
      return;
    }
    if (!chain.started || chain.settling) return;
    chain.settling = true;

    void (async () => {
      if (chain.phase === "planning") {
        const snapshot = await window.pi.sessionSnapshot(file).catch(() => null);
        const messages = (snapshot?.messages ?? []) as PiMessage[];
        // 规划模型提交的计划被用户拒绝：保持计划模式，恢复原模型，不进入执行。
        const planResult = [...messages]
          .reverse()
          .find((m) => m.role === "toolResult" && m.toolName === "ExitPlanMode");
        if (planResult?.isError) {
          await reset(true, true);
          return;
        }
        const executor = chain.executor;
        if (!executor) {
          await reset();
          return;
        }
        chain.phase = "executing";
        chain.started = false;
        chain.settling = false;
        setPhase("executing");

        const details = planResult?.details as { plan?: string; planFile?: string } | undefined;
        let planFile = details?.planFile ?? "";
        if (!planFile) {
          // 规划模型没用 ExitPlanMode：把最后一段正文落成文档做兜底。
          const planText = details?.plan || lastAssistantTextOf(messages);
          const saved = planText
            ? await window.pi.plans
                .save(chain.cwd ?? "", `# 执行方案\n\n${planText}\n`)
                .catch(() => null)
            : null;
          if (saved?.ok && saved.path) planFile = saved.path;
        }
        if (!planFile) {
          await reset();
          return;
        }
        // 关闭规划闸门后执行模型才能写文件 / 跑命令。
        await window.pi.setPlanMode(file, false, false).catch(() => null);
        const directive = `${DUAL_EXEC_PREFIX}\n方案文档：${planFile}（开始前先读取该文件，按它逐项实施）。`;
        const switched = await switchModelFor(file, executor);
        if (!switched) {
          await reset();
          return;
        }
        const res = await promptFor(file, directive, undefined, "followUp");
        if (!res) await reset();
        return;
      }

      // execution settled
      await reset();
    })();
  }, [
    state.isStreaming,
    state.sessionFile,
    state.runningSessions,
    promptFor,
    switchModelFor,
    reset,
  ]);

  const stopAll = useCallback(() => {
    const file = chainRef.current.sessionFile;
    if (chainRef.current.phase !== "idle") void reset();
    send(file ? { type: "abort", sessionFile: file } : { type: "abort" });
  }, [reset, send]);

  return { phase, sessionFile: chainSession, start, reset, stopAll };
}
