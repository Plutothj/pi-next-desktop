import type { FileUIPart } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandInfo,
  ContentBlock,
  ModelInfo,
  PiMessage,
  ProjectInfo,
  QueueState,
  RpcEvent,
  SessionInfo,
  ToolExec,
  UiDialogRequest,
} from "@/lib/pi";

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
  /** Extension widgets pushed via ctx.ui.setWidget（纯文本行，渲染层做轻量结构化）. */
  widgets: Record<string, { lines: string[]; placement: "above" | "below" }>;
  /** Blocking extension dialog (select / input / editor) awaiting an answer. */
  dialog: UiDialogRequest | null;
  /** 正在跑的会话（含后台会话）：侧栏/标题栏据此显示运行指示. */
  runningSessions: Record<string, boolean>;
  autoCompact: boolean;
};

export const initialState: State = {
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
  widgets: {},
  dialog: null,
  autoCompact: true,
  runningSessions: {},
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

// 记录某个会话的运行状态（后台会话靠主进程的 session_status 事件同步）。
function withRunning(state: State, file: string | undefined, running: boolean): State {
  if (!file) return state;
  if (state.runningSessions[file] === running) return state;
  return { ...state, runningSessions: { ...state.runningSessions, [file]: running } };
}

export function reduce(state: State, rec: RpcEvent): State {
  switch (rec.type) {
    case "agent_start":
      return withRunning({ ...state, isStreaming: true }, state.sessionFile, true);
    case "agent_settled":
    case "agent_end":
      return withRunning(
        { ...state, isStreaming: false, streaming: null },
        state.sessionFile,
        false,
      );
    case "session_status": {
      // 后台会话的轻量状态（完整事件不会转发到活动视图）
      if (!rec.sessionFile) return state;
      return withRunning(state, rec.sessionFile, Boolean(rec.isStreaming));
    }
    case "message_start":
      if (rec.message?.role === "assistant") {
        return withRunning(
          { ...state, isStreaming: true, streaming: [{ type: "text", text: "" }] },
          state.sessionFile,
          true,
        );
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
    case "ui_widget": {
      // 扩展 widgets：按 key 存储；lines 为空表示清除该 widget
      const key = rec.key ?? "widget";
      const widgets = { ...state.widgets };
      const lines = (rec.lines ?? []).filter((l) => l !== undefined);
      if (lines.length) widgets[key] = { lines, placement: rec.placement ?? "above" };
      else delete widgets[key];
      return { ...state, widgets };
    }
    case "ui_dialog":
      return { ...state, dialog: rec.dialog ?? null };
    case "ui_dialog_clear":
      return { ...state, dialog: null };
    case "child_exit":
      return {
        ...withRunning(state, state.sessionFile, false),
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
  // 回调里读最新状态的通道（避免闭包过期 / 依赖抖动）
  const stateRef = useRef(state);
  stateRef.current = state;
  const started = useRef(false);

  const refreshSessions = useCallback(async () => {
    const [sessions, projects] = await Promise.all([
      window.pi.sessions().catch(() => []),
      window.pi.projects.list().catch(() => []),
    ]);
    setState((s) => ({ ...s, sessions, projects }));
  }, []);

  // 每模型思考档位记忆：存 ui.json（我们自己的文件，pi 永不覆盖），
  // boot/切会话/切模型后按记忆注入。pi 的 settings.json 旁路写会被它
  // 的进程内存覆盖，所以不走那条路。直接走 window.pi.send（不依赖下方
  // 的 send 包装），可以定义在 boot 之前。
  const applyThinkingPref = useCallback(
    async (model: ModelInfo | undefined, current: string | undefined) => {
      if (!model?.provider || !model?.id) return current ?? null;
      try {
        const prefs = await window.pi.getThinkingPrefs();
        const level = prefs[`${model.provider}/${model.id}`];
        if (level && level !== current) {
          await window.pi.send({ type: "set_thinking_level", level });
          return level;
        }
      } catch {}
      return current ?? null;
    },
    [],
  );

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
          // 扩展 UI 按会话替换，避免上一个会话的 todo/status 残留
          widgets: res.ui?.widgets ?? {},
          statuses: res.ui?.statuses ?? {},
          dialog: null,
          runningSessions:
            typeof st.sessionFile === "string"
              ? { ...s.runningSessions, [st.sessionFile]: Boolean(st.isStreaming) }
              : s.runningSessions,
        }));
        // 按记忆注入该模型的思考档位（用户上次为它选的）
        const applied = await applyThinkingPref(
          st.model as ModelInfo | undefined,
          String(st.thinkingLevel ?? "off"),
        );
        if (applied) setState((s) => ({ ...s, thinkingLevel: applied }));
        refreshSessions();
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "error",
          error: `无法启动 pi：${(err as Error).message}`,
        }));
      }
    },
    [refreshSessions, applyThinkingPref],
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
    return window.pi.onEvent((rec) =>
      setState((s) => {
        // 并排窗格会同时订阅同一批事件；活动视图只吃自己的会话。
        // 其他会话的 agent_* 仍要更新 runningSessions（侧栏运行点）。
        if (rec.sessionFile && s.sessionFile && rec.sessionFile !== s.sessionFile) {
          if (rec.type === "session_status") return reduce(s, rec);
          if (rec.type === "agent_start" || rec.type === "agent_settled" || rec.type === "agent_end") {
            return withRunning(s, rec.sessionFile, rec.type === "agent_start");
          }
          return s;
        }
        return reduce(s, rec);
      }),
    );
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
  // 先清掉本地弹窗再发答复：rpiv 这类扩展在收到答复后会立刻弹下一个对话框，
  // 若等 IPC 返回后才清，会把刚弹出的下一个框一起关掉（表现为"点确认没反应"）。
  const respondDialog = useCallback(
    async (
      dialog: UiDialogRequest,
      values: { value?: string; cancelled?: boolean; confirmed?: boolean },
    ) => {
      setState((s) => (s.dialog?.id === dialog.id ? { ...s, dialog: null } : s));
      await window.pi.respondUi(dialog.id, values).catch(() => null);
    },
    [],
  );

  const buildPromptPayload = useCallback(
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
      return payload;
    },
    [],
  );

  const prompt = useCallback(
    async (text: string, images?: FileUIPart[], behavior?: "steer" | "followUp") =>
      send(await buildPromptPayload(text, images, behavior)),
    [send, buildPromptPayload],
  );

  // 定向发送：双模型链路可能在后台会话里继续跑，不能依赖"当前活动会话"。
  const promptFor = useCallback(
    async (
      sessionFile: string,
      text: string,
      images?: FileUIPart[],
      behavior?: "steer" | "followUp",
    ) => send({ ...(await buildPromptPayload(text, images, behavior)), sessionFile }),
    [send, buildPromptPayload],
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
    setState((s) => {
      const file = (state_.sessionFile as string | undefined) ?? s.sessionFile;
      return {
        ...s,
        messages,
        streaming: null,
        tools: {},
        queue: { steering: [], followUp: [] },
        isStreaming: Boolean(state_.isStreaming),
        sessionFile: file,
        sessionName: state_.sessionName,
        model: state_.model ?? s.model,
        thinkingLevel: state_.thinkingLevel ?? s.thinkingLevel,
        // fork/换会话后旧会话的 todo/status 不能残留；新会话的事件会重新绘制
        widgets: {},
        statuses: {},
        dialog: null,
        runningSessions: file
          ? { ...s.runningSessions, [file]: Boolean(state_.isStreaming) }
          : s.runningSessions,
      };
    });
    // 打开的会话按记忆注入该模型的思考档位（fork/切换后同样生效）
    const applied = await applyThinkingPref(
      (state_.model as ModelInfo | undefined) ?? stateRef.current?.model,
      (state_.thinkingLevel as string | undefined) ?? stateRef.current?.thinkingLevel,
    );
    if (applied) setState((s) => ({ ...s, thinkingLevel: applied }));
    refreshSessions();
    return messages as PiMessage[];
  }, [send, refreshSessions, applyThinkingPref]);

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
      // 切模型后按记忆注入该模型的思考档位
      const applied = await applyThinkingPref(model, stateRef.current?.thinkingLevel);
      if (applied && applied !== stateRef.current?.thinkingLevel) {
        setState((s) => ({ ...s, thinkingLevel: applied }));
      }
    },
    [send, applyThinkingPref],
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

  // 定向切模型：后台会话的双模型链路只改自己的会话，不碰当前活动会话。
  // 目标正好是活动会话时同步更新 UI（否则 picker 会停在执行模型上）。
  const switchModelFor = useCallback(
    async (sessionFile: string, model: ModelInfo) => {
      const res = await send({
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
        sessionFile,
      });
      if (res) setState((s) => (s.sessionFile === sessionFile ? { ...s, model } : s));
      return res;
    },
    [send],
  );

  // 每模型思考档位记忆：存 ui.json（我们自己的文件，pi 永不覆盖），
  // boot/切会话/切模型后按记忆注入。pi 的 settings.json 旁路写会被它
  // 的进程内存覆盖，所以不走那条路。（注入函数 applyThinkingPref 定义在
  // boot 之前，见上。）
  const setThinking = useCallback(
    async (level: string) => {
      setState((s) => ({ ...s, thinkingLevel: level }));
      await send({ type: "set_thinking_level", level });
      if (state.model?.provider && state.model?.id) {
        window.pi
          .setThinkingPref({ provider: state.model.provider, modelId: state.model.id, level })
          .catch(() => null);
      }
    },
    [send, state.model],
  );

  // 新建会话 = 在主进程里新开一个会话槽（独立 pi 进程），不打断当前会话。
  // 旧实现走 pi 的 new_session：那是"替换当前进程里的会话"，会 teardown 正在
  // 跑的回合——同项目开第二个会话时第一个就被打断。
  const newSession = useCallback(async () => {
    let res: Awaited<ReturnType<typeof window.pi.createSession>>;
    try {
      res = await window.pi.createSession(stateRef.current?.cwd);
    } catch (err) {
      setState((s) => ({ ...s, error: `新建会话失败：${(err as Error).message}` }));
      return;
    }
    const fresh = (res.state ?? {}) as Record<string, unknown>;
    setState((s) => {
      const file = res.sessionFile ?? (fresh.sessionFile as string | undefined);
      return {
        ...s,
        cwd: res.cwd,
        messages: res.messages ?? [],
        streaming: null,
        tools: {},
        queue: { steering: [], followUp: [] },
        isStreaming: Boolean(fresh.isStreaming),
        sessionFile: file,
        sessionName: fresh.sessionName as string | undefined,
        model: (fresh.model as ModelInfo | undefined) ?? s.model,
        thinkingLevel: String(fresh.thinkingLevel ?? s.thinkingLevel),
        widgets: res.ui?.widgets ?? {},
        statuses: res.ui?.statuses ?? {},
        dialog: null,
        runningSessions: file
          ? { ...s.runningSessions, [file]: Boolean(fresh.isStreaming) }
          : s.runningSessions,
      };
    });
    // 新会话同样按记忆注入该模型的思考档位
    const applied = await applyThinkingPref(
      (fresh.model as ModelInfo | undefined) ?? stateRef.current?.model,
      (fresh.thinkingLevel as string | undefined) ?? stateRef.current?.thinkingLevel,
    );
    if (applied) setState((s) => ({ ...s, thinkingLevel: applied }));
    refreshSessions();
  }, [refreshSessions, applyThinkingPref]);

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
          widgets: {},
          statuses: {},
          dialog: null,
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
      // 切换 = 换界面显示的活动会话；后台会话的 pi 进程继续跑，不中断。
      const switched = await window.pi
        .switchSession(file, cwd)
        .catch(() => ({ ok: false }));
      if (!switched?.ok || seq !== openSeq.current) return;
      const [st, msgs] = await Promise.all([
        send({ type: "get_state" }),
        send({ type: "get_messages" }),
      ]);
      if (seq !== openSeq.current) return;
      const state_ = (st as any)?.state ?? (st as any) ?? {};
      const messages = (msgs as any)?.messages ?? [];
      const ui = "ui" in switched ? switched.ui : undefined;
      setState((s) => ({
        ...s,
        messages,
        streaming: null,
        tools: {},
        queue: { steering: [], followUp: [] },
        isStreaming: Boolean(state_.isStreaming),
        sessionFile: file,
        sessionName: state_.sessionName,
        model: state_.model ?? s.model,
        thinkingLevel: state_.thinkingLevel ?? s.thinkingLevel,
        // 扩展 UI 跟着会话走：todo/status 一律整体替换，杜绝跨会话串台
        widgets: ui?.widgets ?? {},
        statuses: ui?.statuses ?? {},
        dialog: null,
        runningSessions: { ...s.runningSessions, [file]: Boolean(state_.isStreaming) },
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
    promptFor,
    send,
    clearError,
    respondDialog,
    setModel,
    switchModel,
    switchModelFor,
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
