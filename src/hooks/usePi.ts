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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  /** 用户手动移除的项目路径（有会话的项目靠它从侧栏隐藏）. */
  removedProjects: string[];
  commands: CommandInfo[];
  /** Extension statuses pushed via ctx.ui.setStatus, e.g. a git extension's branch. */
  statuses: Record<string, string>;
  /** Extension widgets pushed via ctx.ui.setWidget（纯文本行，渲染层做轻量结构化）. */
  widgets: Record<string, { lines: string[]; placement: "above" | "below" }>;
  /** Blocking extension dialog (select / input / editor) awaiting an answer. */
  dialog: UiDialogRequest | null;
  /** 正在跑的会话（含后台会话）：侧栏/标题栏据此显示运行指示. */
  runningSessions: Record<string, boolean>;
  /** 最近一条扩展 ui_notify（远程配对地址等需要展示的提示）. */
  notice?: { message: string; notifyType?: string; at: number };
  autoCompact: boolean;
  /** 正在打开一个本次运行还没碰过的会话：先出骨架，等 pi 进程热好再填内容. */
  loadingSession: boolean;
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
  removedProjects: [],
  commands: [],
  statuses: {},
  widgets: {},
  dialog: null,
  autoCompact: true,
  runningSessions: {},
  loadingSession: false,
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
    case "ui_notify": {
      const message = (rec as { message?: string }).message;
      if (typeof message !== "string" || !message.trim()) return state;
      return {
        ...state,
        notice: { message, notifyType: rec.notifyType, at: Date.now() },
      };
    }
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
  // 排队消息的原始 payload（含图片 base64）。pi 的 queue_update 只暴露文本，
  // 所以"立即插入"需要 clear_queue 再重放时，必须靠这份缓存把附件带回去。
  const queuedPayloads = useRef<
    { text: string; behavior: "steer" | "followUp"; payload: Record<string, unknown> }[]
  >([]);

  useEffect(() => {
    const texts = new Set([...state.queue.steering, ...state.queue.followUp]);
    queuedPayloads.current = queuedPayloads.current.filter((entry) => texts.has(entry.text));
  }, [state.queue]);

  const refreshSessions = useCallback(async () => {
    const [sessions, projectState] = await Promise.all([
      window.pi.sessions().catch(() => []),
      // projects:state 同时带回手动移除的路径：侧栏分组由会话 cwd 推出，
      // 只删 projects 列表对有会话的项目无效（会话会把它"变回"项目）。
      window.pi.projects.state().catch(() => ({ projects: [], removed: [] })),
    ]);
    setState((s) => ({
      ...s,
      sessions,
      projects: projectState.projects,
      removedProjects: projectState.removed,
    }));
  }, []);

  // 回合结束后再更新会话列表（标题/时间/改动数），切视图本身不需要扫描。
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefreshRef = useRef<() => void>(() => {});
  const scheduleRefresh = useCallback(() => {
    if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      void refreshSessions();
    }, 350);
  }, [refreshSessions]);
  scheduleRefreshRef.current = scheduleRefresh;

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
          loadingSession: false,
          commands: commands?.commands ?? [],
          autoCompact: Boolean((st.autoCompactionEnabled as boolean) ?? true),
          // 扩展 UI 按会话替换，避免上一个会话的 todo/status 残留
          widgets: res.ui?.widgets ?? {},
          statuses: res.ui?.statuses ?? {},
          dialog: res.dialog ?? null,
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

  // 打开项目 = 固定进项目列表 + 在该目录新建会话槽（见下方 openProject）。

  // 事件按帧合并：每条 IPC 都 setState 会让 markdown 每个 token 重新解析，
  // 长回复 + 滚动时最容易掉帧。delta 之外的 tool_execution / widget / status /
  // queue 也一起攒 16ms 再进 reducer（一次 setState 只跑一遍 React 渲染）。
  // 但 message_end / agent_end / 对话框这类"必须立刻看到"的事件先 flush 队列，
  // 保证它们严格排在已到达的 delta 之后。用 setTimeout 而不是 rAF：窗口被
  // 遮挡/最小化时 rAF 会被暂停，deltas 会一直憋到 message_end 才一次性出现
  // （实测门控窗口下就是"流式全丢"）。
  const pendingEvents = useRef<RpcEvent[]>([]);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 这些事件不能被延迟：回合/消息的收尾决定 streaming 状态，阻塞对话框要立即上屏
  const URGENT_EVENTS = new Set<RpcEvent["type"]>([
    "message_end",
    "agent_end",
    "agent_settled",
    "child_exit",
    "ui_dialog",
    "ui_dialog_clear",
  ]);

  // Subscribe on every mount: StrictMode's mount → cleanup → remount cycle
  // would otherwise leave the listener detached (dev builds only).
  useEffect(() => {
    const applyEvent = (s: State, rec: RpcEvent): State => {
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
    };
    const flushPending = (s: State): State => {
      if (batchTimer.current !== null) {
        clearTimeout(batchTimer.current);
        batchTimer.current = null;
      }
      if (!pendingEvents.current.length) return s;
      const batch = pendingEvents.current;
      pendingEvents.current = [];
      return batch.reduce(applyEvent, s);
    };
    const unsub = window.pi.onEvent((rec) => {
      // 会话结束（前台或后台）再 debounce 刷新侧栏元数据；切视图不再扫描
      if (
        rec.type === "agent_settled" ||
        (rec.type === "session_status" && rec.isStreaming === false)
      ) {
        scheduleRefreshRef.current();
      }
      if (URGENT_EVENTS.has(rec.type)) {
        // 先把积压的事件应用掉，再应用这条（顺序不能反）
        setState((s) => applyEvent(flushPending(s), rec));
        return;
      }
      pendingEvents.current.push(rec);
      if (batchTimer.current === null) {
        batchTimer.current = setTimeout(() => {
          batchTimer.current = null;
          setState((s) => flushPending(s));
        }, 16);
      }
    });
    return () => {
      unsub();
      if (batchTimer.current !== null) clearTimeout(batchTimer.current);
      batchTimer.current = null;
      pendingEvents.current = [];
      if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
      pendingRefresh.current = null;
    };
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

  const clearNotice = useCallback(() => {
    setState((s) => (s.notice ? { ...s, notice: undefined } : s));
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
    async (text: string, images?: FileUIPart[], behavior?: "steer" | "followUp") => {
      const payload = await buildPromptPayload(text, images, behavior);
      // 流式中发送 = 进入 pi 的排队；记下完整 payload（含图片）供"立即插入"重放
      if (behavior && stateRef.current?.isStreaming) {
        const message = String(payload.message ?? text);
        queuedPayloads.current.push({ text: message, behavior, payload });
        if (queuedPayloads.current.length > 50) {
          queuedPayloads.current.splice(0, queuedPayloads.current.length - 50);
        }
      }
      return send(payload);
    },
    [send, buildPromptPayload],
  );

  /** 当前排队的消息 → 原始 payload 快照（在 clear_queue 之前调用）。 */
  const snapshotQueuedPayloads = useCallback(() => {
    const queue = stateRef.current?.queue;
    if (!queue) return [];
    const texts = new Set([...queue.steering, ...queue.followUp]);
    return queuedPayloads.current
      .filter((entry) => texts.has(entry.text))
      .map((entry) => ({ ...entry, payload: { ...entry.payload } }));
  }, []);

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
        loadingSession: false,
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
  const newSession = useCallback(async (cwd?: string) => {
    let res: Awaited<ReturnType<typeof window.pi.createSession>>;
    try {
      res = await window.pi.createSession(cwd ?? stateRef.current?.cwd);
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
        loadingSession: false,
        sessionName: fresh.sessionName as string | undefined,
        model: (fresh.model as ModelInfo | undefined) ?? s.model,
        thinkingLevel: String(fresh.thinkingLevel ?? s.thinkingLevel),
        widgets: res.ui?.widgets ?? {},
        statuses: res.ui?.statuses ?? {},
        dialog: res.dialog ?? null,
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

  // 打开项目 = 固定进项目列表 + 在该目录**新建一个会话槽**。
  // 必须走 pi:createSession（唯一临时键、独立进程）：以前的 boot（pi:start）
  // 用共享键起新会话，多项目并行时可能命中/重绑别的正在跑的槽。
  const openProject = useCallback(
    async (dir: string) => {
      await window.pi.projects.add(dir).catch(() => null);
      await newSession(dir);
    },
    [newSession],
  );

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
          loadingSession: false,
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
  // 每个会话最近一次的视图（消息 + 状态 + 扩展 UI）。来回切换时先用缓存即时上屏，
  // 再只在 messageCount 变化时重取全量消息：切会话不再每次都搬整个历史
  // （ZCode 的 tail-window 思路；长会话一次 get_messages 就是几 MB）。
  const viewCache = useRef(
    new Map<
      string,
      {
        messages: PiMessage[];
        state: Record<string, unknown>;
        ui?: { widgets: State["widgets"]; statuses: State["statuses"] };
      }
    >(),
  );

  const openSession = useCallback(
    async (file: string, cwd?: string) => {
      const seq = ++openSeq.current;
      const cached = viewCache.current.get(file);
      // 本次运行没打开过时，先拿 SQLite 里的尾部消息缓存（重启后的秒开）
      let seed = cached?.messages ?? null;
      if (!seed) {
        const saved = await window.pi.sessionView(file).catch(() => null);
        if (seq !== openSeq.current) return;
        if (saved?.messages?.length) seed = saved.messages;
      }
      let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
      if (cached) {
        // 内存缓存优先：先把界面切过去（含消息和扩展 UI），不阻塞在 pi 启动上
        setState((s) => ({
          ...s,
          messages: seed ?? cached.messages,
          streaming: null,
          tools: {},
          queue: { steering: [], followUp: [] },
          isStreaming: Boolean(cached.state.isStreaming),
          sessionFile: file,
          sessionName: cached.state.sessionName as string | undefined,
          model: (cached.state.model as ModelInfo) ?? s.model,
          thinkingLevel: String(cached.state.thinkingLevel ?? s.thinkingLevel),
          widgets: cached.ui?.widgets ?? {},
          statuses: cached.ui?.statuses ?? {},
          dialog: null,
          loadingSession: false,
          runningSessions: { ...s.runningSessions, [file]: Boolean(cached.state.isStreaming) },
          ...(cwd ? { cwd } : {}),
        }));
      } else if (seed) {
        // 有持久缓存但内存里没有（重启/首次打开）：先渲染缓存，后台再刷新
        setState((s) => ({
          ...s,
          messages: seed,
          streaming: null,
          tools: {},
          queue: { steering: [], followUp: [] },
          isStreaming: false,
          sessionFile: file,
          sessionName: undefined,
          widgets: {},
          statuses: {},
          dialog: null,
          loadingSession: false,
          ...(cwd ? { cwd } : {}),
        }));
      } else {
        // 连持久缓存都没有：清空视图，150ms 后显示骨架——pi 进程已经在跑时
        // 通常一瞬间就拿到数据，骨架不会闪一下。
        setState((s) => ({
          ...s,
          messages: [],
          streaming: null,
          tools: {},
          queue: { steering: [], followUp: [] },
          isStreaming: false,
          sessionFile: file,
          sessionName: undefined,
          widgets: {},
          statuses: {},
          dialog: null,
          loadingSession: false,
          ...(cwd ? { cwd } : {}),
        }));
        skeletonTimer = setTimeout(() => {
          if (seq === openSeq.current) {
            setState((s) => (s.sessionFile === file ? { ...s, loadingSession: true } : s));
          }
        }, 150);
      }
      // 切换 = 换界面显示的活动会话；后台会话的 pi 进程继续跑，不中断。
      // 不等进程拉起（wait=false）：主进程后台预热，渲染层轮询补数据。
      const switched = await window.pi
        .switchSession(file, cwd, { wait: false })
        .catch(() => ({ ok: false, warming: false, ui: undefined, dialog: null as UiDialogRequest | null }));
      if (!switched?.ok || seq !== openSeq.current) {
        if (skeletonTimer) clearTimeout(skeletonTimer);
        return;
      }
      // 目标会话的扩展 UI / 待回答对话框（很便宜，优先补齐）
      if (cached) {
        setState((s) => ({
          ...s,
          widgets: switched.ui?.widgets ?? s.widgets,
          statuses: switched.ui?.statuses ?? s.statuses,
          dialog: switched.dialog ?? null,
        }));
      }
      // get_state 很轻；进程还在后台拉起时重试（pi 未运行 会立即抛错）
      let st = await window.pi.send({ type: "get_state" }).catch(() => null);
      for (let i = 0; !st && i < 80; i++) {
        await sleep(250);
        if (seq !== openSeq.current) {
          if (skeletonTimer) clearTimeout(skeletonTimer);
          return;
        }
        st = await window.pi.send({ type: "get_state" }).catch(() => null);
      }
      if (skeletonTimer) clearTimeout(skeletonTimer);
      if (st === null) {
        if (!cached) {
          setState((s) => ({
            ...s,
            loadingSession: false,
            error: "打开会话超时：pi 进程未能启动",
          }));
        }
        return; // 缓存视图保留
      }
      if (seq !== openSeq.current) return;
      const state_ = (st as any)?.state ?? (st as any) ?? {};
      const count = typeof state_.messageCount === "number" ? state_.messageCount : null;
      // 消息数没变（且不在流式）就完全跳过全量 get_messages
      const seedCount = seed?.length ?? 0;
      const fresh = !seed || (count !== null && count !== seedCount) || Boolean(state_.isStreaming);
      const msgs = fresh
        ? await window.pi.send({ type: "get_messages" }).catch(() => null)
        : null;
      if (seq !== openSeq.current) return;
      const messages = ((msgs as any)?.messages ?? seed ?? []) as PiMessage[];
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
        widgets: ui?.widgets ?? s.widgets,
        statuses: ui?.statuses ?? s.statuses,
        // 切到这个会话时它还在等回答的阻塞对话框（后台 pi 一直挂着）
        dialog: switched?.dialog ?? null,
        loadingSession: false,
        runningSessions: { ...s.runningSessions, [file]: Boolean(state_.isStreaming) },
        // Session files record their own cwd; cross-project switches follow it.
        ...(cwd ? { cwd } : {}),
      }));
    },
    [],
  );

  // 活动会话的视图随消息更新写回缓存（切走再切回能直接用）
  useEffect(() => {
    const file = state.sessionFile;
    if (!file) return;
    viewCache.current.set(file, {
      messages: state.messages,
      state: {
        sessionName: state.sessionName,
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        isStreaming: state.isStreaming,
      },
      ui: { widgets: state.widgets, statuses: state.statuses },
    });
  }, [
    state.sessionFile,
    state.messages,
    state.sessionName,
    state.model,
    state.thinkingLevel,
    state.isStreaming,
    state.widgets,
    state.statuses,
  ]);

  return {
    state,
    boot,
    openProject,
    prompt,
    promptFor,
    snapshotQueuedPayloads,
    send,
    clearError,
    clearNotice,
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
