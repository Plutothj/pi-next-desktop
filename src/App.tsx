import { useCallback, useEffect, useState } from "react";
import {
  BotIcon,
  BrainIcon,
  FilesIcon,
  GlobeIcon,
  Minimize2Icon,
  TerminalIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PromptInputButton,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Chat } from "@/components/chat";
import { Composer } from "@/components/composer";
import { BranchPicker } from "@/components/branch-picker";
import { ContextUsage } from "@/components/context-usage";
import { ModelPicker } from "@/components/model-picker";
import { SessionSidebar } from "@/components/sidebar";
import { SettingsDialog, type SettingsTab } from "@/components/settings-dialog";
import { UpdateDialog } from "@/components/update-dialog";
import { expandAttachments } from "@/lib/attachments";
import { TerminalPanel } from "@/components/terminal-panel";
import { FilesPanel } from "@/components/files-panel";
import { AgentsPanel } from "@/components/agents-panel";
import { BrowserPanel } from "@/components/browser-panel";
import { CommandPalette, type PanelTab } from "@/components/command-palette";
import { ExtensionDialog } from "@/components/extension-dialog";
import { DualModelDialog } from "@/components/dual-model-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { usePi } from "@/hooks/usePi";
import { useTasks } from "@/hooks/useTasks";
import { useGit } from "@/hooks/useGit";
import { useSessionStats } from "@/hooks/useSessionStats";
import { useDualModel } from "@/hooks/useDualModel";
import { useDualModelChain } from "@/hooks/useDualModelChain";
import { useUpdater } from "@/hooks/useUpdater";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import type { PiMessage } from "@/lib/pi";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// pi has no plan mode, so the toggle sends a directive with the prompt and
// keeps the UI in a read-only-ish posture. Tools are still available to the model.
const PLAN_PREFIX =
  "只做分析与方案：不要修改文件、不要执行写操作命令，给出分步骤方案后停下等我确认。\n\n";

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
    forkAt,
  } = usePi();
  const controller = usePromptInputController();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [planMode, setPlanMode] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dualOpen, setDualOpen] = useState(false);
  const dual = useDualModel();
  const dualChain = useDualModelChain({ dual, state, switchModel, prompt, send });
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once

  const onUpdateAction = () => {
    setUpdateOpen(true);
    const { status } = updater.state;
    if (status === "idle" || status === "up-to-date") updater.check();
    // available/downloading/ready/error/dev：弹窗按当前状态渲染，无需重复动作
  };
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const { tasks, run: runTask, kill: killTask, remove: removeTask, hosts } = useTasks();
  const { git, refresh: refreshGit } = useGit(state.cwd, state.isStreaming);
  const { stats, refresh: refreshStats } = useSessionStats(
    state.sessionFile,
    state.isStreaming,
  );

  (window as unknown as Record<string, unknown>).__pi = state;

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
  }, [state.status]);

  // ⌘N — new task, mirroring ZCode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const submit = async (message: PromptInputMessage, behavior?: "steer" | "followUp") => {
    const text = message.text.trim();
    if (!text) return;
    // 附件分流：图片走原生 image part，其余解析为文本块内联进 prompt
    const { images, extraText } = await expandAttachments(message.files);
    // A fresh task with dual-model enabled starts the planning turn.
    if (dual.config.enabled && dualChain.phase === "idle" && !state.isStreaming) {
      const planner = dual.find(state.models, dual.config.planner);
      const executor = dual.find(state.models, dual.config.executor);
      if (planner && executor) {
        dualChain.start(text, images, planner);
        return;
      }
    }
    const body = planMode ? PLAN_PREFIX + text : text;
    // Always name a streamingBehavior: it only matters while pi is mid-run
    // (where a missing one is rejected outright), and is ignored when idle.
    // This keeps sends working even if our isStreaming flag lags reality.
    prompt(extraText ? `${body}\n\n${extraText}` : body, images, behavior ?? "followUp");
  };

  const localCommand = (name: string) => {
    if (name === "new") newSession();
    else if (name === "compact") compact();
    else if (name === "plan") setPlanMode((v) => !v);
  };

  // Fork rebuilds history up to (not including) the chosen user prompt and
  // returns its text; prefill the composer so it can be edited and resent.
  const handleFork = useCallback(
    async (message: PiMessage) => {
      const res = await forkAt(message);
      if (res.ok && res.text) controller.textInput.setInput(res.text);
    },
    [forkAt, controller],
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <SessionSidebar
        state={state}
        theme={theme}
        update={updater.state}
        onUpdateAction={onUpdateAction}
        onNewSession={newSession}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSkills={() => openSettings("skills")}
        onOpenSettings={() => openSettings("general")}
        onToggleTheme={toggleTheme}
        openProject={openProject}
        openSession={openSession}
        deleteSession={deleteSession}
        renameSession={renameSession}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="max-w-56 truncate text-xs text-muted-foreground">
            {state.sessionName ?? "未命名会话"}
          </span>
          {planMode ? (
            <Badge className="text-[10px]" variant="secondary">
              计划模式
            </Badge>
          ) : null}

          <div className="no-drag ml-auto flex items-center gap-1.5">
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
              className={cn("h-7 px-2 text-xs", panel === "agents" && "bg-accent")}
              onClick={() => setPanel(panel === "agents" ? null : "agents")}
              title="子智能体"
              variant="ghost"
            >
              <BotIcon className="size-3.5" />
            </Button>
            <Button
              className={cn("h-7 px-2 text-xs", panel === "browser" && "bg-accent")}
              onClick={() => setPanel(panel === "browser" ? null : "browser")}
              title="内置浏览器"
              variant="ghost"
            >
              <GlobeIcon className="size-3.5" />
            </Button>
            <Button
              className="h-7 px-2 text-xs"
              onClick={compact}
              title="压缩上下文"
              variant="ghost"
            >
              <Minimize2Icon className="size-3.5" />
            </Button>
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

        <Chat onFork={handleFork} state={state} />

        <div className="mx-auto w-full max-w-3xl px-6 pb-4 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-[1800px]:max-w-7xl">
          {git?.isRepo || Object.keys(state.statuses).length > 0 || dualChain.phase !== "idle" ? (
            <div className="mb-1.5 flex items-center gap-2 px-1">
              {git?.isRepo ? (
                <BranchPicker cwd={state.cwd} git={git} onSwitched={refreshGit} />
              ) : null}
              {dualChain.phase !== "idle" ? (
                <span className="flex items-center gap-1 rounded-md border bg-background/60 px-2 py-1 text-[11px] text-primary">
                  <WorkflowIcon className="size-3" />
                  {dualChain.phase === "planning" ? "规划中" : "执行中"} · {state.model?.name ?? ""}
                </span>
              ) : null}
              {Object.entries(state.statuses).map(([key, text]) => (
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
          <div className="relative">
            <ExtensionDialog dialog={state.dialog} onRespond={respondDialog} />
            <Composer
              commands={state.commands}
              cwd={state.cwd}
              onClearQueue={() => send({ type: "clear_queue" })}
              onLocalCommand={localCommand}
              onStop={dualChain.stopAll}
              onSubmit={submit}
              onTogglePlan={() => setPlanMode((v) => !v)}
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
        </div>
      </main>

      <SettingsDialog
        cwd={state.cwd}
        onChanged={() => boot(state.cwd)}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
        open={settingsOpen}
      />

      {panel ? (
        <aside className="flex w-96 shrink-0 flex-col border-l bg-sidebar">
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
            {panel === "files" ? <FilesPanel changes={git?.changes} cwd={state.cwd} /> : null}
            {panel === "agents" ? <AgentsPanel cwd={state.cwd} state={state} /> : null}
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
