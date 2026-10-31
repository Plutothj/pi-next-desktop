import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CommandInfo,
  type ContentBlock,
  type ModelInfo,
  type PiMessage,
  type QueueState,
  type RpcEvent,
  type SessionInfo,
  type ToolExec,
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
  commands: CommandInfo[];
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
  commands: [],
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
    case "child_exit":
      return {
        ...state,
        status: "exited",
        isStreaming: false,
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
    const sessions = await window.pi.sessions().catch(() => []);
    setState((s) => ({ ...s, sessions }));
  }, []);

  const boot = useCallback(async (cwd?: string) => {
    setState((s) => ({ ...s, status: "connecting", error: undefined }));
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
      isStreaming: Boolean(st.isStreaming),
      model: (st.model as ModelInfo) ?? undefined,
      thinkingLevel: String(st.thinkingLevel ?? "off"),
      sessionName: st.sessionName as string | undefined,
      sessionFile: st.sessionFile as string | undefined,
      commands: commands?.commands ?? [],
      autoCompact: Boolean((st.autoCompactionEnabled as boolean) ?? true),
    }));
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const off = window.pi.onEvent((rec) => setState((s) => reduce(s, rec)));
    boot();
    return off;
  }, [boot]);

  const send = useCallback(async (payload: Record<string, unknown>) => {
    try {
      return await window.pi.send(payload);
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
      return null;
    }
  }, []);

  const prompt = useCallback(
    async (text: string, images?: FileUIPart[]) => {
      const payload: Record<string, unknown> = { type: "prompt", message: text };
      if (images?.length) {
        payload.images = await Promise.all(
          images.map(async (file) => ({
            type: "image" as const,
            // FileUIPart.url is a data URL for local files.
            data: file.url.slice(file.url.indexOf(",") + 1),
            mimeType: file.mediaType ?? "image/png",
          })),
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

  const fork = useCallback(
    async (entryId: string) => {
      await send({ type: "fork", entryId });
      const msgs = (await send({ type: "get_messages" })) as { messages?: PiMessage[] } | null;
      setState((s) => ({ ...s, messages: msgs?.messages ?? s.messages, streaming: null }));
    },
    [send],
  );

  const sessionStats = useCallback(async () => {
    const res = (await send({ type: "get_session_stats" })) as Record<string, unknown> | null;
    return res;
  }, [send]);

  const setModel = useCallback(
    async (model: ModelInfo) => {
      setState((s) => ({ ...s, model }));
      await send({ type: "set_model", provider: model.provider, modelId: model.id });
    },
    [send],
  );

  const setThinking = useCallback(
    async (level: string) => {
      setState((s) => ({ ...s, thinkingLevel: level }));
      await send({ type: "set_thinking_level", level });
    },
    [send],
  );

  const newSession = useCallback(async () => {
    await send({ type: "new_session" });
    setState((s) => ({ ...s, messages: [], streaming: null, tools: {}, queue: { steering: [], followUp: [] } }));
    refreshSessions();
  }, [send, refreshSessions]);

  const openSession = useCallback(
    async (file: string) => {
      await send({ type: "switch_session", sessionPath: file });
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
        sessionFile: file,
        sessionName: state_.sessionName,
        model: state_.model ?? s.model,
        thinkingLevel: state_.thinkingLevel ?? s.thinkingLevel,
      }));
    },
    [send],
  );

  return {
    state,
    boot,
    prompt,
    send,
    setModel,
    setThinking,
    newSession,
    openSession,
    refreshSessions,
    renameSession,
    compact,
    fork,
    sessionStats,
  };
}
