import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandInfo,
  ContentBlock,
  ModelInfo,
  PiMessage,
  ProjectInfo,
  UiDialogRequest,
  QueueState,
  RpcEvent,
  SessionInfo,
  ToolExec,
} from "@/lib/pi";
import type { FileUIPart } from "ai";

// Transcript windows render a few dozen turns; older tool entries can go.
const TOOL_LIMIT = 400;
function trimTools(tools: Record<string, ToolExec>) {
  const ids = Object.keys(tools);
  if (ids.length <= TOOL_LIMIT) return tools;
  const keep = ids.slice(-TOOL_LIMIT);
  return Object.fromEntries(keep.map((id) => [id, tools[id]]));
}

export type State = {
  status: "connecting" | "ready" | "error" | "exited";
  error?: string;
  cwd: string;
  model?: ModelInfo;
  models: ModelInfo[];
  thinkingLevel: string;
  isStreaming: boolean;
  messages: PiMessage[];
  streaming: ContentBlock[] | null;
  tools: Record<string, ToolExec>;
  queue: QueueState;
  sessionName?: string;
  sessionFile?: string;
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  commands: CommandInfo[];
  /** Extension statuses pushed via ctx.ui.setStatus, e.g. a git extension's branch. */
  statuses: Record<string, string>;
  /** Blocking extension dialog (select / input / editor) awaiting an answer. */
  dialog: UiDialogRequest | null;
  autoCompact: boolean;
};

const initialState: State = {
  status: "connecting",
  cwd: "",
  models: [],
  thinkingLevel: "off",
  isStreaming: false,
  messages: [],
  streaming: null,
  tools: {},
  queue: { steering: [], followUp: [] },
  sessions: [],
  projects: [],
  commands: [],
  statuses: {},
  dialog: null,
  autoCompact: true,
};

// Deltas arrive only for the block being written, so patch by contentIndex.
// The *_end event carries the authoritative content; message_end replaces all.
function applyBlockEvent(blocks: ContentBlock[], ev: NonNullable<RpcEvent["assistantMessageEvent"]>) {
  const i = ev.contentIndex ?? blocks.length;
  const next = blocks.slice();

  switch (ev.type) {
    case "text_start":
      next[i] = { type: "text", text: "" };
      break;
    case "text_delta":
      next[i] = { type: "text", text: ((next[i] as any)?.text ?? "") + (ev.delta ?? "") };
      break;
    case "text_end":
      next[i] = { type: "text", text: ev.content ?? (next[i] as any)?.text ?? "" };
      break;
    case "thinking_start":
      next[i] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      next[i] = { type: "thinking", thinking: ((next[i] as any)?.thinking ?? "") + (ev.delta ?? "") };
      break;
    case "thinking_end":
      next[i] = { type: "thinking", thinking: ev.content ?? (next[i] as any)?.thinking ?? "" };
      break;
    case "toolcall_start":
      next[i] = { type: "toolCall", id: ev.id ?? "", name: ev.toolName ?? "", arguments: {} };
      break;
    case "toolcall_end":
      if (ev.toolCall) next[i] = ev.toolCall;
      break;
    default:
      return blocks;
  }
  return next.filter(Boolean);
}

function reduce(state: State, rec: RpcEvent): State {
  switch (rec.type) {
    case "agent_start":
      return { ...state, isStreaming: true };
    case "agent_settled":
    case "agent_end":
      return { ...state, isStreaming: false, streaming: null };
    case "message_start":
      if (rec.message?.role === "assistant") {
        return { ...state, isStreaming: true, streaming: [{ type: "text", text: "" }] };
      }
      return state;
    case "message_update": {
      if (!rec.assistantMessageEvent) return state;
      return {
        ...state,
        streaming: applyBlockEvent(state.streaming ?? [], rec.assistantMessageEvent),
      };
    }
    case "message_end": {
      if (!rec.message) return state;
      if (rec.message.role === "assistant") {
        return { ...state, messages: [...state.messages, rec.message], streaming: null };
      }
      return { ...state, messages: [...state.messages, rec.message] };
    }
    case "tool_execution_start":
      if (!rec.toolCallId) return state;
      return {
        ...state,
        tools: {
          ...trimTools(state.tools),
          [rec.toolCallId]: { name: rec.toolName ?? "", args: rec.args, status: "running" },
        },
      };
    case "tool_execution_end": {
      if (!rec.toolCallId) return state;
      const prev = state.tools[rec.toolCallId];
      return {
        ...state,
        tools: {
          ...state.tools,
          [rec.toolCallId]: {
            name: prev?.name ?? rec.toolName ?? "",
            args: prev?.args,
            status: rec.isError ? "error" : "done",
            result: rec.result,
            durationMs: rec.durationMs,
          },
        },
      };
    }
    case "queue_update":
      return { ...state, queue: { steering: rec.steering ?? [], followUp: rec.followUp ?? [] } };
    case "ui_status": {
      const key = rec.key ?? "status";
      const statuses = { ...state.statuses };
      if (rec.text) statuses[key] = rec.text;
      else delete statuses[key];
      return { ...state, statuses };
    }
    case "ui_dialog":
      return { ...state, dialog: rec.dialog ?? null };
    case "ui_dialog_clear":
      return { ...state, dialog: null };
    case "child_exit":
      return {
        ...state,
        status: "exited",
        isStreaming: false,
        dialog: null,
        error: `pi 进程退出 (${rec.code ?? rec.signal ?? "?"})`,
      };
    default:
      return state;
  }
}

export function usePi() {
  const [state, setState] = useState<State>(initialState);
  const started = useRef(false);

  const refreshSessions = useCallback(async () => {
    const [sessions, projects] = await Promise.all([
      window.pi.sessions().catch(() => []),
      window.pi.projects.list().catch(() => []),
    ]);
    setState((s) => ({ ...s, sessions, projects }));
  }, []);

  const boot = useCallback(
    async (cwd?: string) => {
      setState((s) => ({ ...s, status: "connecting", error: undefined }));
      try {
        const res = await window.pi.start(cwd);
        const st = res.state ?? {};
        const commands = (await window.pi
          .send({ type: "get_commands" })
          .catch(() => null)) as { commands?: CommandInfo[] } | null;
        setState((s) => ({
          ...s,
          status: "ready",
          cwd: res.cwd,
          models: res.models,
          messages: res.messages,
          streaming: null,
          tools: {},
          queue: { steering: [], followUp: [] },
          isStreaming: Boolean(st.isStreaming),
          model: (st.model as ModelInfo) ?? undefined,
          thinkingLevel: String(st.thinkingLevel ?? "off"),
          sessionName: st.sessionName as string | undefined,
          sessionFile: st.sessionFile as string | undefined,
          commands: commands?.commands ?? [],
          autoCompact: Boolean((st.autoCompactionEnabled as boolean) ?? true),
        }));
        refreshSessions();
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "error",
          error: `无法启动 pi：${(err as Error).message}`,
        }));
      }
    },
    [refreshSessions],
  );

  // Opening a project pins it to the project list, then boots pi inside it.
  const openProject = useCallback(
    async (dir: string) => {
      await window.pi.projects.add(dir).catch(() => null);
      await boot(dir);
    },
    [boot],
  );

  // Subscribe on every mount: StrictMode's mount → cleanup → remount cycle
  // would otherwise leave the listener detached (dev builds only).
  useEffect(() => {
    return window.pi.onEvent((rec) => setState((s) => reduce(s, rec)));
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    boot();
  }, [boot]);

  const send = useCallback(async (payload: Record<string, unknown>) => {
    try {
      const res = await window.pi.send(payload);
      // Any successful RPC means the connection is healthy again.
      setState((s) => (s.error ? { ...s, error: undefined } : s));
      return res;
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
      return null;
    }
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: undefined }));
  }, []);

  // Answers a blocking extension dialog; pi resumes once the response lands.
  const respondDialog = useCallback(
    async (dialog: UiDialogRequest, values: { value?: string; cancelled?: boolean }) => {
      await window.pi.respondUi(dialog.id, values).catch(() => null);
      setState((s) => ({ ...s, dialog: null }));
    },
    [],
  );

  const prompt = useCallback(
    async (text: string, images?: FileUIPart[], behavior?: "steer" | "followUp") => {
      const payload: Record<string, unknown> = { type: "prompt", message: text };
      // While streaming, pi routes the message by streamingBehavior instead of
      // throwing "Agent is already processing".
      if (behavior) payload.streamingBehavior = behavior;
      if (images?.length) {
        payload.images = await Promise.all(
          images.map(async (file) => {
            // url 可能是 blob: 或 data:——统一取真实字节转 base64
            // （旧实现对 blob: URL 做 slice(indexOf(",")) 会把 blob 字符串当数据发出去）
            const blob = await (await fetch(file.url)).blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            }
            return {
              type: "image" as const,
              data: btoa(binary),
              mimeType: file.mediaType?.split(";")[0] || blob.type || "image/png",
            };
          }),
        );
      }
      return send(payload);
    },
    [send],
  );

  const renameSession = useCallback(
    async (name: string) => {
      await send({ type: "set_session_name", name });
      setState((s) => ({ ...s, sessionName: name }));
      refreshSessions();
    },
    [send, refreshSessions],
  );

  const compact = useCallback(() => send({ type: "compact" }), [send]);

  // After a fork/switch the whole session identity moves; mirror it locally.
  const syncAfterSwitch = useCallback(async () => {
    const [st, msgs] = await Promise.all([
      send({ type: "get_state" }),
      send({ type: "get_messages" }),
    ]);
    const state_ = (st as any)?.state ?? (st as any) ?? {};
    const messages = (msgs as any)?.messages ?? [];
    setState((s) => ({
      ...s,
      messages,
      streaming: null,
      tools: {},
      queue: { steering: [], followUp: [] },
      isStreaming: Boolean(state_.isStreaming),
      sessionFile: (state_.sessionFile as string | undefined) ?? s.sessionFile,
      sessionName: state_.sessionName,
      model: state_.model ?? s.model,
      thinkingLevel: state_.thinkingLevel ?? s.thinkingLevel,
    }));
    refreshSessions();
    return messages as PiMessage[];
  }, [send, refreshSessions]);

  const fork = useCallback(
    async (entryId: string): Promise<{ ok: boolean; text?: string }> => {
      const res = (await send({ type: "fork", entryId })) as
        | { text?: string; cancelled?: boolean }
        | null;
      if (!res || res.cancelled) return { ok: false };
      await syncAfterSwitch();
      return { ok: true, text: res.text };
    },
    [send, syncAfterSwitch],
  );

  // pi's fork takes a session entry id, not a message object; entries carry
  // ids while get_messages does not, so match on role + timestamp.
  const forkAt = useCallback(
    async (message: PiMessage): Promise<{ ok: boolean; text?: string }> => {
      const res = (await send({ type: "get_entries" })) as
        | { entries?: Array<{ type: string; id: string; message?: PiMessage }> }
        | null;
      const entry = (res?.entries ?? []).find(
        (e) =>
          e.type === "message" &&
          e.message?.role === message.role &&
          e.message?.timestamp === message.timestamp,
      );
      if (!entry) {
        setState((s) => ({ ...s, error: "找不到这条消息对应的会话条目，无法分支" }));
        return { ok: false };
      }
      // User prompts fork natively ("before" + prefill). The RPC has no
      // fork-at, so assistant/tool entries use the file-level fork instead.
      if (entry.message?.role === "user") return fork(entry.id);
      const fileFork = await window.pi
        .forkSessionAt(entry.id)
        .catch((err) => ({ ok: false as const, error: String(err) }));
      if (!fileFork.ok) {
        setState((s) => ({ ...s, error: fileFork.error ?? "分支失败" }));
        return { ok: false };
      }
      await syncAfterSwitch();
      return { ok: true };
    },
    [send, fork, syncAfterSwitch],
  );

  const sessionStats = useCallback(async () => {
    const res = (await send({ type: "get_session_stats" })) as Record<string, unknown> | null;
    return res;
  }, [send]);

  const setModel = useCallback(
    async (model: ModelInfo) => {
      setState((s) => ({ ...s, model }));
      await send({ type: "set_model", provider: model.provider, modelId: model.id });
      // Persist as pi's default so new sessions (including after an app
      // restart) start on this model instead of resetting to settings.
      window.pi.cfg
        .setSetting({ defaultProvider: model.provider, defaultModel: model.id })
        .catch(() => null);
    },
    [send],
  );

  // Internal model switch (dual-model chain): updates the live session but
  // leaves the user's persisted default model untouched.
  const switchModel = useCallback(
    async (model: ModelInfo) => {
      setState((s) => ({ ...s, model }));
      return send({ type: "set_model", provider: model.provider, modelId: model.id });
    },
    [send],
  );

  const setThinking = useCallback(
    async (level: string) => {
      setState((s) => ({ ...s, thinkingLevel: level }));
      await send({ type: "set_thinking_level", level });
      window.pi.cfg.setSetting({ defaultThinkingLevel: level }).catch(() => null);
    },
    [send],
  );

  const newSession = useCallback(async () => {
    await send({ type: "new_session" });
    // Re-read state so the header and the sidebar highlight follow the fresh
    // session instead of silently staying on the old one.
    const st = (await send({ type: "get_state" })) as Record<string, unknown> | null;
    const fresh = (st as { state?: Record<string, unknown> })?.state ?? st ?? {};
    setState((s) => ({
      ...s,
      messages: [],
      streaming: null,
      tools: {},
      queue: { steering: [], followUp: [] },
      isStreaming: false,
      sessionFile: fresh.sessionFile as string | undefined,
      sessionName: fresh.sessionName as string | undefined,
    }));
    refreshSessions();
  }, [send, refreshSessions]);

  const deleteSession = useCallback(
    async (file: string) => {
      const res = await window.pi.deleteSession(file).catch(() => null);
      if (!res?.ok) {
        setState((s) => ({ ...s, error: res?.error ?? "删除会话失败" }));
        return;
      }
      if (res.switched) {
        // The main process moved pi onto a fresh session; mirror that here.
        const st = (await send({ type: "get_state" })) as Record<string, unknown> | null;
        const fresh = (st as { state?: Record<string, unknown> })?.state ?? st ?? {};
        setState((s) => ({
          ...s,
          messages: [],
          streaming: null,
          tools: {},
          queue: { steering: [], followUp: [] },
          isStreaming: false,
          sessionFile: fresh.sessionFile as string | undefined,
          sessionName: fresh.sessionName as string | undefined,
        }));
      }
      refreshSessions();
    },
    [send, refreshSessions],
  );

  // Rapid clicks on different rows race each other; only the latest applies.
  const openSeq = useRef(0);
  const openSession = useCallback(
    async (file: string, cwd?: string) => {
      const seq = ++openSeq.current;
      const switched = await send({ type: "switch_session", sessionPath: file });
      if (!switched || seq !== openSeq.current) return;
      const [st, msgs] = await Promise.all([
        send({ type: "get_state" }),
        send({ type: "get_messages" }),
      ]);
      if (seq !== openSeq.current) return;
      const state_ = (st as any)?.state ?? (st as any) ?? {};
      const messages = (msgs as any)?.messages ?? [];
      setState((s) => ({
        ...s,
        messages,
        streaming: null,
        tools: {},
        queue: { steering: [], followUp: [] },
        sessionFile: file,
        sessionName: state_.sessionName,
        model: state_.model ?? s.model,
        thinkingLevel: state_.thinkingLevel ?? s.thinkingLevel,
        // Session files record their own cwd; cross-project switches follow it.
        ...(cwd ? { cwd } : {}),
      }));
    },
    [send],
  );

  return {
    state,
    boot,
    openProject,
    prompt,
    send,
    clearError,
    respondDialog,
    setModel,
    switchModel,
    setThinking,
    newSession,
    openSession,
    deleteSession,
    refreshSessions,
    renameSession,
    compact,
    fork,
    forkAt,
    sessionStats,
  };
}
