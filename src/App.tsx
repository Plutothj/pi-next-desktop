import {
  BotIcon,
  BrainIcon,
  ClipboardListIcon,
  Columns2Icon,
  CopyIcon,
  FilesIcon,
  GlobeIcon,
  ListTreeIcon,
  Minimize2Icon,
  MinusIcon,
  PanelLeftOpenIcon,
  RocketIcon,
  SmartphoneIcon,
  SquareIcon,
  TerminalIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentsPanel } from "@/components/agents-panel";
import {
  PromptInputButton,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { BoardPanel } from "@/components/board-panel";
import { BranchPicker } from "@/components/branch-picker";
import { BrowserPanel } from "@/components/browser-panel";
import { Chat } from "@/components/chat";
import { CommandPalette, type PanelTab } from "@/components/command-palette";
import { Composer } from "@/components/composer";
import { ContextUsage } from "@/components/context-usage";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DualModelDialog } from "@/components/dual-model-dialog";
import { ExtensionDialog } from "@/components/extension-dialog";
import { FilesPanel } from "@/components/files-panel";
import { ModelPicker } from "@/components/model-picker";
import { OnboardingTour, startTour } from "@/components/onboarding";
import { PlanWorkbench } from "@/components/plan-workbench";
import { RemoteDialog } from "@/components/remote-dialog";
import { SessionTreePanel } from "@/components/session-tree";
import { SettingsDialog, type SettingsTab } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { SessionSidebar } from "@/components/sidebar";
import { SplitPane } from "@/components/split-pane";
import { TerminalPanel } from "@/components/terminal-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UpdateDialog } from "@/components/update-dialog";
import { WidgetStrip } from "@/components/widget-strip";
import { useNotifications } from "@/hooks/notifications";
import { useDualModel } from "@/hooks/useDualModel";
import { useDualModelChain } from "@/hooks/useDualModelChain";
import { useGit } from "@/hooks/useGit";
import { usePi } from "@/hooks/usePi";
import { useSessionStats } from "@/hooks/useSessionStats";
import { useTasks } from "@/hooks/useTasks";
import { useTheme } from "@/hooks/useTheme";
import { useUpdater } from "@/hooks/useUpdater";
import { expandAttachments } from "@/lib/attachments";
import { lastAssistantTextOf, type PiMessage, textOf } from "@/lib/pi";
import { stripDirective } from "@/lib/promptPrefixes";
import { cn } from "@/lib/utils";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export default function App() {
  return (
    <PromptInputProvider>
      <Shell />
    </PromptInputProvider>
  );
}

function Shell() {
  const {
    state,
    boot,
    openProject,
    prompt,
    promptFor,
    snapshotQueuedPayloads,
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
  } = usePi();
  const controller = usePromptInputController();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  // 计划模式是会话级事实（扩展每次 tool_call 读会话旁路的 sidecar），
  // 这里切会话/回合结束/流式中轮询把它同步到 UI（模型也能主动 EnterPlanMode）。
  useEffect(() => {
    const file = state.sessionFile;
    if (!file) return;
    let alive = true;
    window.pi
      .getPlanMode(file)
      .then((r) => {
        if (alive) setPlanMode(Boolean(r.enabled));
      })
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [state.sessionFile]);

  useEffect(() => {
    if (!state.isStreaming || !state.sessionFile) return;
    const file = state.sessionFile;
    const id = setInterval(() => {
      window.pi
        .getPlanMode(file)
        .then((r) => setPlanMode(Boolean(r.enabled)))
        .catch(() => null);
    }, 1500);
    return () => clearInterval(id);
  }, [state.isStreaming, state.sessionFile]);

  const togglePlanMode = useCallback(async () => {
    const next = !planMode;
    setPlanMode(next);
    const file = state.sessionFile;
    if (file) await window.pi.setPlanMode(file, next).catch(() => null);
  }, [planMode, state.sessionFile]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 并排窗格：右栏显示另一个会话的实时转录（只读），点聚焦互换。
  const [splitPane, setSplitPane] = useState<{ file: string; cwd?: string } | null>(null);
  const [dualOpen, setDualOpen] = useState(false);
  const dual = useDualModel(state.sessionFile);
  // 每回合结束 +1：让文件面板在 AI 改写文件后自动重读预览
  const [previewTick, setPreviewTick] = useState(0);
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !state.isStreaming) setPreviewTick((n) => n + 1);
    wasStreaming.current = state.isStreaming;
  }, [state.isStreaming]);
  const dualChain = useDualModelChain({ state, promptFor, switchModelFor, send });
  const updater = useUpdater();
  const { theme, toggle: toggleTheme } = useTheme();
  const [restartDismissed, setRestartDismissed] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [availableDismissed, setAvailableDismissed] = useState<string | null>(null);
  const showRestart =
    updater.state.status === "ready" &&
    updater.state.version !== null &&
    !updateOpen &&
    restartDismissed !== updater.state.version;
  // 后台检查发现新版：toast 提醒（下载中的进度走按钮与弹窗）
  const showAvailable =
    updater.state.status === "available" &&
    updater.state.version !== null &&
    !updateOpen &&
    availableDismissed !== updater.state.version;

  // 静默检查：启动 8 秒后一次，此后每 4 小时一次
  useEffect(() => {
    const first = setTimeout(() => updater.check(), 8000);
    const interval = setInterval(() => updater.check(), 4 * 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [updater.check]); // eslint-disable-line react-hooks/exhaustive-deps -- run once

  const onUpdateAction = () => {
    setUpdateOpen(true);
    const { status } = updater.state;
    if (status === "idle" || status === "up-to-date") updater.check();
    // available/downloading/ready/error/dev：弹窗按当前状态渲染，无需重复动作
  };

  // 会话标题：pi 只在手动重命名后才有 sessionName，否则顶栏永远是"未命名
  // 会话"。首条用户消息出现时派生标题并走 set_session_name 持久化（与侧栏
  // 扫描的兜底规则一致：首条用户消息）。
  const autoTitled = useRef<string | null>(null);
  const firstUser = state.messages.find((m) => m.role === "user");
  const derivedTitle = (() => {
    if (!firstUser) return null;
    const clean = stripDirective(textOf(firstUser.content)).text.replace(/\s+/g, " ").trim();
    if (!clean) return null;
    return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
  })();
  useEffect(() => {
    if (state.sessionName || !state.sessionFile || !derivedTitle) return;
    if (autoTitled.current === state.sessionFile) return;
    autoTitled.current = state.sessionFile;
    void renameSession(derivedTitle);
  });
  const headerTitle = state.sessionName ?? derivedTitle ?? "未命名会话";

  // 计划模式：回合结束后把最终方案落盘为 .pi/plans/plan-*.md（ZCode 同款），
  // 文档是持久产物，会话里的那轮回复只是展示。
  const prevPlanStreaming = useRef(false);
  const [planSavedPath, setPlanSavedPath] = useState<string | null>(null);
  useEffect(() => {
    const settled = prevPlanStreaming.current && !state.isStreaming;
    prevPlanStreaming.current = state.isStreaming;
    if (!settled || !planMode) return;
    const planText = lastAssistantTextOf(state.messages);
    if (!planText) return;
    void window.pi.plans
      .save(state.cwd, `# 计划\n\n${planText}\n`)
      .then((saved) => {
        if (saved?.ok && saved.path) {
          setPlanSavedPath(saved.path);
          setTimeout(() => setPlanSavedPath(null), 12_000);
        }
        return null;
      })
      .catch(() => null);
  });

  const [panel, setPanel] = useState<PanelTab | null>(null);
  // 右侧面板宽度：可拖拽调整并持久化（表格预览需要横向空间）
  const [panelWidth, setPanelWidth] = useState(384);
  useEffect(() => {
    window.pi
      .getPref("panelWidth")
      .then((r) => {
        if (typeof r.value === "number" && r.value >= 320 && r.value <= 900) setPanelWidth(r.value);
      })
      .catch(() => null);
  }, []);
  const startPanelResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (e: PointerEvent) => {
      // 向左拖 → 变宽
      const next = Math.min(900, Math.max(320, startWidth + (startX - e.clientX)));
      setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPanelWidth((w) => {
        window.pi.setPref("panelWidth", w).catch(() => null);
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [panelWidth]);
  // 侧栏折叠：持久化在 ui.json（与缩放/思考档位同一层 app prefs）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    window.pi
      .getPref("sidebarCollapsed")
      .then((r) => {
        if (typeof r.value === "boolean") setSidebarCollapsed(r.value);
      })
      .catch(() => null);
  }, []);
  const toggleSidebar = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    window.pi.setPref("sidebarCollapsed", next).catch(() => null);
  }, []);

  // 聊天附件 chip 点开预览：{abs,name,seq} 传给文件面板
  const [previewFile, setPreviewFile] = useState<{ abs: string; name: string; seq: number } | null>(null);
  const { tasks, run: runTask, kill: killTask, remove: removeTask, hosts } = useTasks();
  useNotifications(state.runningSessions, state.sessions, tasks);
  const { git, refresh: refreshGit } = useGit(state.cwd, state.isStreaming);
  const { stats, refresh: refreshStats } = useSessionStats(
    state.sessionFile,
    state.isStreaming,
  );

  // 界面缩放快捷键（Ctrl/Cmd + = - 0，10% 步进），反馈气泡显示当前倍率
  const [zoomPill, setZoomPill] = useState<number | null>(null);
  // 无边框窗口的最大化状态（自绘按钮显示还原/最大化）
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    window.pi.win.state().then((s) => setWinMaximized(s.maximized)).catch(() => {});
    return window.pi.onEvent((rec) => {
      if (rec.type === "win_maximized") setWinMaximized(Boolean(rec.value));
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const act =
        e.key === "=" || e.key === "+"
          ? () => window.pi.zoom(0.1)
          : e.key === "-"
            ? () => window.pi.zoom(-0.1)
            : e.key === "0"
              ? () => window.pi.zoomReset()
              : null;
      if (!act) return;
      e.preventDefault();
      void act().then((res) => {
        if (res?.ok && res.factor) {
          setZoomPill(res.factor);
          setTimeout(() => setZoomPill(null), 1600);
        }
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  (window as unknown as Record<string, unknown>).__pi = state;
  // 调试/E2E 句柄：会话切换（与 __pi 同级）
  (window as unknown as Record<string, unknown>).__piOpenSession = openSession;
  (window as unknown as Record<string, unknown>).__piOpenProject = openProject;
  (window as unknown as Record<string, unknown>).__piRefreshSessions = refreshSessions;

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Fade out the boot splash once pi is ready (or failed, so the error UI shows).
  useEffect(() => {
    const { status } = state;
    if (status !== "ready" && status !== "error" && status !== "exited") return;
    const splash = document.getElementById("boot-splash");
    if (!splash) return;
    splash.classList.add("hide");
    const timer = setTimeout(() => splash.remove(), 400);
    return () => clearTimeout(timer);
  }, [state.status, state]);

  // ⌘N — new task, mirroring ZCode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newSession();
      }
      // ⌘B / Ctrl+B：收起/展开侧栏
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((prev) => {
          window.pi.setPref("sidebarCollapsed", !prev).catch(() => null);
          return !prev;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  // 版本页「重看引导」：先关设置弹窗（Radix 层级更高会挡住聚光灯）
  useEffect(() => {
    const onTour = () => {
      setSettingsOpen(false);
      setTimeout(() => startTour(), 250);
    };
    window.addEventListener("pi:tour", onTour);
    return () => window.removeEventListener("pi:tour", onTour);
  }, []);

  // 草稿持久化：输入框内容按会话/工作区记在 ui.json，崩溃或重启后可恢复。
  // 只恢复"用户最后留下且未发出"的草稿——发送成功会清空并删键。
  // 按工作区记草稿：会话文件每次启动都会新建（或切会话），用它做键会导致
  // 重开应用后找不到草稿。工作区是稳定的，且"同一项目里没发出去的那段话"
  // 正是用户期望恢复的东西。
  const draftKey = `draft:${state.cwd || "default"}`;
  const draftLoaded = useRef(false);
  const draftRestored = useRef(false);
  useEffect(() => {
    draftLoaded.current = false;
    draftRestored.current = false;
    window.pi
      .getPref(draftKey)
      .then((r) => {
        draftLoaded.current = true;
        if (typeof r.value === "string" && r.value && !controller.textInput.value) {
          controller.textInput.setInput(r.value);
          draftRestored.current = true;
        }
      })
      .catch(() => {
        draftLoaded.current = true;
      });
    // controller.textInput 每次渲染都是新对象，不能进依赖（会把 draftLoaded 打回 false）
    // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  }, [draftKey]);

  // 输入变化 → 防抖写盘（1s）；空内容删除键
  useEffect(() => {
    const text = controller.textInput.value;
    if (!draftLoaded.current) return;
    // 刚恢复的草稿不要立刻写回，避免覆盖用户正在输入的内容
    const id = setTimeout(() => {
      draftRestored.current = false;
      if (text) window.pi.setPref(draftKey, text).catch(() => null);
      else window.pi.setPref(draftKey, "").catch(() => null);
    }, 1000);
    return () => clearTimeout(id);
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只追输入值与键
  }, [controller.textInput.value, draftKey]);

  // 聊天附件 chip → 打开右侧文件面板并预览该文件
  useEffect(() => {
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ abs: string; name: string }>).detail;
      if (!detail?.abs) return;
      setPanel("files");
      setPreviewFile({ abs: detail.abs, name: detail.name, seq: Date.now() });
    };
    window.addEventListener("pi:preview-file", onPreview);
    return () => window.removeEventListener("pi:preview-file", onPreview);
  }, []);

  // 队列项「插入」：把该条立即注入当前回合（steer），其余项按原顺序重排。
  // pi 只有 clear_queue（无单条出队），所以清空后按 目标→其余打断→其余排队 重发。
  const insertQueued = useCallback(
    async (text: string, kind: "steering" | "followUp") => {
      const q = state.queue;
      const steering = [...q.steering];
      const followUp = [...q.followUp];
      // 从对应队列里按值移除一条（保留重复项的其余副本）
      const targetList = kind === "steering" ? steering : followUp;
      const idx = targetList.indexOf(text);
      if (idx === -1) return;
      targetList.splice(idx, 1);

      // pi 的 queue_update 只有文本；clear_queue 会丢掉 pi 内部队列里的图片，
      // 所以先在清空之前拿到每条消息的原始 payload（含图片 base64）。
      const cached = snapshotQueuedPayloads();
      const payloadFor = (value: string, source: "steering" | "followUp") =>
        cached.find(
          (entry) =>
            entry.text === value &&
            entry.behavior === (source === "steering" ? "steer" : "followUp"),
        )?.payload;
      const deliver = async (
        value: string,
        source: "steering" | "followUp",
        behavior: "steer" | "followUp",
      ) => {
        const payload = payloadFor(value, source);
        if (payload) await send({ ...payload, streamingBehavior: behavior });
        else await prompt(value, undefined, behavior);
      };

      await send({ type: "clear_queue" });
      // 目标先插（steer 会在当前回复的下一个边界立刻生效）
      await deliver(text, kind, "steer");
      for (const m of steering) await deliver(m, "steering", "steer");
      for (const m of followUp) await deliver(m, "followUp", "followUp");
    },
    [send, prompt, state.queue, snapshotQueuedPayloads],
  );

  const submit = async (message: PromptInputMessage, behavior?: "steer" | "followUp") => {
    const text = message.text.trim();
    if (!text) return;
    // 附件分流：图片走原生 image part，其余解析为文本块内联进 prompt
    const { images, extraText, saved } = await expandAttachments(message.files);
    // 附件落盘索引：按 (cwd, ts) 记账，聊天里的 chip 据此点开预览
    if (saved.length) {
      const ts = Date.now();
      window.pi
        .recordAttachments({ cwd: state.cwd, ts, files: saved })
        .then(() => window.dispatchEvent(new CustomEvent("pi:attachments-changed")))
        .catch(() => null);
    }
    // A fresh task with dual-model enabled starts the planning turn.
    if (dual.config.enabled && dualChain.phase === "idle" && !state.isStreaming) {
      const planner = dual.find(state.models, dual.config.planner);
      const executor = dual.find(state.models, dual.config.executor);
      if (planner && executor) {
        dualChain.start(text, images, planner, executor);
        return;
      }
    }
    // 计划模式不再往用户消息里拼话术：约束由 plan-mode 扩展注入系统提示 +
    // tool_call 闸门实现，用户消息保持原文。
    prompt(extraText ? `${text}\n\n${extraText}` : text, images, behavior ?? "followUp");
  };

  const localCommand = (name: string) => {
    if (name === "new") newSession();
    else if (name === "compact") compact();
    else if (name === "plan") void togglePlanMode();
  };

  // 调试/E2E 句柄：直接提交一条消息（双模型链路等动线用）
  (window as unknown as Record<string, unknown>).__piSubmit = submit;

  // 编辑重发：fork 截断到此提问之前，原文预填进输入框并聚焦，改完 Enter 重发
  const handleFork = useCallback(
    async (message: PiMessage) => {
      const res = await forkAt(message);
      if (res.ok && res.text) {
        controller.textInput.setInput(res.text);
        document.querySelector<HTMLTextAreaElement>('[data-editor="main"]')?.focus();
      }
    },
    [forkAt, controller],
  );

  // 会话树：按 entryId 从任意节点重走（与编辑重发同一条 fork 通路）
  const handleForkEntry = useCallback(
    async (entryId: string) => {
      const res = await fork(entryId);
      if (res.ok && res.text) {
        controller.textInput.setInput(res.text);
        document.querySelector<HTMLTextAreaElement>('[data-editor="main"]')?.focus();
      }
    },
    [fork, controller],
  );

  // 计划工作台：按落盘的计划文档执行（先读文档再逐项实施）
  const executePlan = useCallback(
    (file: string) => {
      void prompt(
        `请先读取计划文档 ${file}，然后严格按计划逐项实施并验证；与计划不符处做最小必要调整并在最后说明偏差。`,
        undefined,
        "followUp",
      );
    },
    [prompt],
  );

  // 并排：优先选另一个"正在跑"的会话，其次最近更新的会话。
  const toggleSplit = useCallback(() => {
    if (splitPane) {
      setSplitPane(null);
      return;
    }
    const candidate = [...state.sessions]
      .filter((s) => s.path !== state.sessionFile)
      .sort((a, b) => {
        const ra = state.runningSessions[a.path] ? 1 : 0;
        const rb = state.runningSessions[b.path] ? 1 : 0;
        return rb - ra || b.mtime - a.mtime;
      })[0];
    if (candidate) setSplitPane({ file: candidate.path, cwd: candidate.cwd });
  }, [splitPane, state.sessions, state.sessionFile, state.runningSessions]);

  // 聚焦右栏：把它的会话变成活动会话，原活动会话转到右栏继续跑。
  const focusSplit = useCallback(
    async (file: string, cwd?: string) => {
      const prev = state.sessionFile;
      const prevCwd = state.cwd;
      await openSession(file, cwd);
      setSplitPane(prev && prev !== file ? { file: prev, cwd: prevCwd } : null);
    },
    [openSession, state.sessionFile, state.cwd],
  );

  // 从侧栏直接打开了右栏会话：右栏让位，回到单栏。
  useEffect(() => {
    if (splitPane && splitPane.file === state.sessionFile) setSplitPane(null);
  }, [splitPane, state.sessionFile]);

  // 远程面板命令：/remote 由 pi 当扩展命令执行，不会进模型回合
  const runRemoteCommand = useCallback(
    (command: string) => {
      if (!state.sessionFile) return;
      // 设备/设置会拉扩展 select/input 弹层，先关掉模态框，否则弹层被挡住
      if (command === "/remote devices" || command === "/remote settings") setRemoteOpen(false);
      void send({ type: "prompt", message: command });
    },
    [send, state.sessionFile],
  );

  // 计划模式已有专门徽章/开关，不再重复渲染扩展的 status chip
  const statusChips = Object.entries(state.statuses).filter(([key]) => key !== "plan");
  // 后台会话的双模型链路不把"规划中/执行中"徽章显示在别的会话上
  const chainHere = dualChain.phase !== "idle" && dualChain.sessionFile === state.sessionFile;
  const plannerModel = dual.find(state.models, dual.config.planner);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {sidebarCollapsed ? null : (
      <SessionSidebar
        onCollapse={() => toggleSidebar(true)}
        state={state}
        theme={theme}
        update={updater.state}
        onUpdateAction={onUpdateAction}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSkills={() => openSettings("skills")}
        onCreateProject={() => setCreateProjectOpen(true)}
        onOpenSettings={() => openSettings("general")}
        onToggleTheme={toggleTheme}
        onRemoveProject={async (dir) => {
          await window.pi.projects.remove(dir).catch(() => null);
          await refreshSessions();
        }}
        openProject={openProject}
        openSession={openSession}
        deleteSession={deleteSession}
        renameSession={renameSession}
      />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="@container drag flex h-12 shrink-0 items-center gap-2 border-b px-4"
          onDoubleClick={(e) => {
            // 自绘标题栏：双击切换最大化（点在按钮上除外）
            if (window.pi.platform === "darwin") return;
            if ((e.target as HTMLElement).closest("button")) return;
            void window.pi.win.toggleMaximize();
          }}
        >
          {sidebarCollapsed ? (
            <Button
              // 头部整条是拖拽区（-webkit-app-region: drag），按钮必须显式
              // 标 no-drag，否则 Windows 无边框窗口下点击被系统当成拖动吞掉
              className="no-drag h-7 shrink-0 px-2 text-muted-foreground"
              onClick={() => toggleSidebar(false)}
              size="sm"
              title="展开侧栏（⌘B）"
              variant="ghost"
            >
              <PanelLeftOpenIcon className="size-3.5" />
            </Button>
          ) : null}
          <span className="min-w-0 max-w-56 truncate text-xs text-muted-foreground" title={headerTitle}>
            {headerTitle}
          </span>
          {planMode ? (
            <Badge className="text-[10px]" variant="secondary">
              计划模式
            </Badge>
          ) : null}

          {/* 工具区可收缩：窗口控制块固定不参与压缩，窄了先藏次要按钮 */}
          <div className="no-drag ml-auto flex min-w-0 items-center gap-1.5 self-stretch">
            <Button
              className={cn("h-7 px-2 text-xs", panel === "terminal" && "bg-accent")}
              onClick={() => setPanel(panel === "terminal" ? null : "terminal")}
              title="终端 / 后台任务"
              variant="ghost"
            >
              <TerminalIcon className="size-3.5" />
              {tasks.some((t) => t.status === "running") ? (
                <span className="ml-0.5 size-1.5 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              className={cn("h-7 px-2 text-xs", panel === "files" && "bg-accent")}
              onClick={() => setPanel(panel === "files" ? null : "files")}
              title="文件"
              variant="ghost"
            >
              <FilesIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @2xl:flex", splitPane && "bg-accent")}
              onClick={toggleSplit}
              title="并排显示另一个会话（再点关闭）"
              variant="ghost"
            >
              <Columns2Icon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @2xl:flex", state.statuses.remote && "bg-accent")}
              onClick={() => setRemoteOpen(true)}
              title="远程访问：手机扫码继续所有会话"
              variant="ghost"
            >
              <SmartphoneIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @2xl:flex", panel === "agents" && "bg-accent")}
              onClick={() => setPanel(panel === "agents" ? null : "agents")}
              title="子智能体"
              variant="ghost"
            >
              <BotIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @2xl:flex", panel === "board" && "bg-accent")}
              onClick={() => setPanel(panel === "board" ? null : "board")}
              title="并行任务"
              variant="ghost"
            >
              <RocketIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @2xl:flex", panel === "tree" && "bg-accent")}
              onClick={() => setPanel(panel === "tree" ? null : "tree")}
              title="会话树"
              variant="ghost"
            >
              <ListTreeIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @3xl:flex", panel === "plan" && "bg-accent")}
              onClick={() => setPanel(panel === "plan" ? null : "plan")}
              title="计划"
              variant="ghost"
            >
              <ClipboardListIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("hidden h-7 px-2 text-xs @3xl:flex", panel === "browser" && "bg-accent")}
              onClick={() => setPanel(panel === "browser" ? null : "browser")}
              title="内置浏览器"
              variant="ghost"
            >
              <GlobeIcon className="size-3.5" />
            </Button>
            <Button
              className="hidden h-7 px-2 text-xs @3xl:flex"
              onClick={compact}
              title="压缩上下文"
              variant="ghost"
            >
              <Minimize2Icon className="size-3.5" />
            </Button>

            {/* OS 领地（仅无边框平台）：Windows caption 语法——贴角、满高、
                方角，与应用工具之间用发丝线分界；关闭悬停用系统关闭红。
                关闭走 close 拦截转托盘，与原生 X 行为一致。 */}
            {window.pi.platform !== "darwin" ? (
              <div className="-mr-4 ml-2 flex shrink-0 self-stretch border-l border-border/60">
                <button
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => void window.pi.win.minimize()}
                  title="最小化"
                  type="button"
                >
                  <MinusIcon className="size-3.5" />
                </button>
                <button
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => void window.pi.win.toggleMaximize()}
                  title={winMaximized ? "还原" : "最大化"}
                  type="button"
                >
                  {winMaximized ? (
                    <CopyIcon className="size-3" />
                  ) : (
                    <SquareIcon className="size-3" />
                  )}
                </button>
                <button
                  className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-[#e81123] hover:text-white"
                  onClick={() => void window.pi.win.closeApp()}
                  title="关闭"
                  type="button"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {state.error || state.status === "exited" || state.status === "error" ? (
          <div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
            <span className="min-w-0 flex-1 break-words">{state.error ?? "连接失败"}</span>
            <button
              className="shrink-0 rounded px-1 opacity-60 hover:opacity-100"
              onClick={clearError}
              title="清除错误"
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
        <Chat onFork={handleFork} state={state} />

        <div className="mx-auto w-full max-w-3xl px-6 pb-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-[1800px]:max-w-7xl">
          {git?.isRepo || statusChips.length > 0 || chainHere ? (
            <div className="mb-1.5 flex items-center gap-2 px-1">
              {git?.isRepo ? (
                <BranchPicker cwd={state.cwd} git={git} onSwitched={refreshGit} />
              ) : null}
              {chainHere ? (
                <span className="flex items-center gap-1 rounded-md border bg-background/60 px-2 py-1 text-[11px] text-primary">
                  <WorkflowIcon className="size-3" />
                  {dualChain.phase === "planning" ? "规划中" : "执行中"} · {state.model?.name ?? ""}
                </span>
              ) : null}
              {statusChips.map(([key, text]) => (
                <span
                  className="max-w-64 truncate rounded-md border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
                  key={key}
                  title={key}
                >
                  {text}
                </span>
              ))}
            </div>
          ) : null}
          <WidgetStrip placement="above" widgets={state.widgets} data-widget-strip />
          <div className="relative">
            <ExtensionDialog dialog={state.dialog} onRespond={respondDialog} />
            <Composer
              commands={state.commands}
              cwd={state.cwd}
              onClearQueue={() => send({ type: "clear_queue" })}
              onQueueInsert={insertQueued}
              onLocalCommand={localCommand}
              onStop={dualChain.stopAll}
              onSubmit={submit}
              onTogglePlan={() => void togglePlanMode()}
              planMode={planMode}
              queue={state.queue}
              streaming={state.isStreaming}
            >
              <ContextUsage onRefresh={refreshStats} stats={stats} />
              <PromptInputButton
                className={cn("gap-1 text-xs", dual.config.enabled && "text-primary")}
                onClick={() => setDualOpen(true)}
                title="双模型：规划模型出方案，执行模型落地"
              >
                <WorkflowIcon className="size-3.5" />
                {dual.config.enabled ? "双模型" : "单模型"}
              </PromptInputButton>
              {dual.config.enabled ? (
                <PromptInputButton
                  className="gap-1 text-xs text-muted-foreground"
                  onClick={() => setDualOpen(true)}
                  title="规划模型（只出方案）；右侧模型是执行模型，点此修改双模型配置"
                >
                  <WorkflowIcon className="size-3.5" />
                  规划
                  <span className="max-w-24 truncate font-medium text-foreground/80">
                    {plannerModel?.name ?? "未选"}
                  </span>
                </PromptInputButton>
              ) : null}
              <ModelPicker
                model={state.model}
                models={state.models}
                onSelect={setModel}
              />
              <PromptInputSelect onValueChange={setThinking} value={state.thinkingLevel}>
                <PromptInputSelectTrigger className="h-7 gap-1 text-xs">
                  <BrainIcon className="size-3.5" />
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {THINKING.map((t) => (
                    <PromptInputSelectItem key={t} value={t}>
                      {t}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            </Composer>
          </div>
          <WidgetStrip placement="below" widgets={state.widgets} />
        </div>
          </div>
          {splitPane && splitPane.file !== state.sessionFile ? (
            <SplitPane
              activeFile={state.sessionFile}
              cwd={splitPane.cwd}
              file={splitPane.file}
              key={splitPane.file}
              onClose={() => setSplitPane(null)}
              onFocus={focusSplit}
              onPick={(file, cwd) => setSplitPane({ file, cwd })}
              sessions={state.sessions}
            />
          ) : null}
        </div>
      </main>

      <RemoteDialog
        notice={state.notice}
        onCommand={runRemoteCommand}
        onOpenChange={setRemoteOpen}
        open={remoteOpen}
        ready={state.status === "ready" && Boolean(state.sessionFile)}
        status={state.statuses.remote}
      />

      <SettingsDialog
        cwd={state.cwd}
        onChanged={() => boot(state.cwd)}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
        open={settingsOpen}
      />

      {/* 首启新手引导（自动触发条件见组件）；版本页「重看引导」经 pi:tour 事件 */}
      <OnboardingTour state={state} />

      {panel ? (
        <aside
          className="relative flex shrink-0 flex-col border-l bg-sidebar"
          data-panel
          style={{ width: panelWidth }}
        >
          <button
            aria-label="调整面板宽度"
            className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize hover:bg-primary/30"
            onPointerDown={startPanelResize}
            type="button"
          />
          <div className="flex h-12 shrink-0 items-center gap-0.5 border-b px-2">
            {([
              ["files", "文件", FilesIcon],
              ["terminal", "终端", TerminalIcon],
              ["agents", "子智能体", BotIcon],
              ["browser", "浏览器", GlobeIcon],
            ] as const).map(([tab, label, Icon]) => (
              <button
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent",
                  panel === tab && "bg-accent text-foreground",
                )}
                key={tab}
                onClick={() => setPanel(tab)}
                type="button"
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
            <Button
              className="ml-auto h-6 px-1.5"
              onClick={() => setPanel(null)}
              size="sm"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {panel === "terminal" ? (
              <TerminalPanel
                cwd={state.cwd}
                onKill={killTask}
                onRemove={removeTask}
                hosts={hosts}
                onRun={(cmd, host) => runTask(cmd, state.cwd, host)}
                tasks={tasks}
              />
            ) : null}
            {panel === "files" ? (
              <FilesPanel
                changes={git?.changes}
                cwd={state.cwd}
                dark={theme === "dark"}
                onAskAi={(text) => {
                  controller.textInput.setInput(text);
                }}
                previewRequest={previewFile}
                refreshToken={previewTick}
              />
            ) : null}
            {panel === "agents" ? <AgentsPanel cwd={state.cwd} state={state} /> : null}
            {panel === "board" ? <BoardPanel cwd={state.cwd} onPromote={openSession} /> : null}
            {panel === "tree" ? (
              <SessionTreePanel onForkEntry={handleForkEntry} sessionFile={state.sessionFile} />
            ) : null}
            {panel === "plan" ? (
              <PlanWorkbench cwd={state.cwd} onExecute={executePlan} />
            ) : null}
            {panel === "browser" ? <BrowserPanel cwd={state.cwd} /> : null}
          </div>
        </aside>
      ) : null}

      <CommandPalette
        actions={{
          newSession,
          compact,
          settings: () => openSettings("general"),
          pickFolder: async () => {
            const dir = await window.pi.pickFolder();
            if (dir) openProject(dir);
          },
          panel: (tab) => setPanel(tab),
          openSession: (path, cwd) => openSession(path, cwd),
          shortcuts: () => setShortcutsOpen(true),
          checkUpdate: () => onUpdateAction(),
          diagnostics: () => {
            window.pi.diagExport();
          },
        }}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
        sessions={state.sessions}
      />

      {zoomPill ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-card px-3.5 py-1.5 text-xs shadow-lg">
          界面缩放 {Math.round(zoomPill * 100)}%
        </div>
      ) : null}

      {planSavedPath ? (
        <div className="fixed right-6 bottom-6 z-50 max-w-md rounded-lg border bg-card px-4 py-2.5 text-xs shadow-lg">
          计划已保存：
          <span className="font-mono break-all">{planSavedPath}</span>
          <button
            className="ml-3 text-muted-foreground hover:text-foreground"
            onClick={() => setPlanSavedPath(null)}
            type="button"
          >
            ✕
          </button>
        </div>
      ) : null}

      <CreateProjectDialog
        onCreate={async (dir) => {
          await window.pi.projects.add(dir).catch(() => null);
          await openProject(dir);
        }}
        onOpenChange={setCreateProjectOpen}
        open={createProjectOpen}
      />

      <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />

      <UpdateDialog
        onOpenChange={setUpdateOpen}
        open={updateOpen}
        updater={updater}
      />

      {/* 后台检查发现新版本：不打断，可稍后 */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setAvailableDismissed(updater.state.version ?? null);
        }}
        open={showAvailable}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">发现新版本 v{updater.state.version ?? ""}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            当前 v{updater.state.current}，可以更新到新版本。
          </p>
          <DialogFooter className="gap-2">
            <Button
              onClick={() => setAvailableDismissed(updater.state.version ?? null)}
              size="sm"
              variant="ghost"
            >
              稍后
            </Button>
            <Button onClick={() => setUpdateOpen(true)} size="sm">
              去更新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRestartDismissed(updater.state.version ?? null);
        }}
        open={showRestart}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              已下载 {updater.state.version ?? "新版本"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">重启应用以完成安装。</p>
          <DialogFooter className="gap-2">
            <Button
              onClick={() => setRestartDismissed(updater.state.version ?? null)}
              size="sm"
              variant="ghost"
            >
              稍后
            </Button>
            <Button onClick={updater.install} size="sm">
              立即重启安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DualModelDialog
        config={dual.config}
        models={state.models}
        onOpenChange={setDualOpen}
        open={dualOpen}
        setEnabled={dual.setEnabled}
        setExecutor={dual.setExecutor}
        setPlanner={dual.setPlanner}
      />
    </div>
  );
}
