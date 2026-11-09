import { useCallback, useEffect, useRef } from "react";
import type { SessionInfo, TaskInfo } from "@/lib/pi";

// 窗口不在前台（托盘/最小化/失焦）时，用系统通知播报回合完成与后台任务结束；
// 点击通知唤起窗口。前台使用时不打扰。
export function useNotifications(
  runningSessions: Record<string, boolean>,
  sessions: SessionInfo[],
  tasks: TaskInfo[],
) {
  const prevRunning = useRef<Record<string, boolean>>({});
  const prevTasks = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  }, []);

  const notify = useCallback((title: string, body: string) => {
    if (document.hasFocus()) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.pi.showWindow();
      window.focus();
      n.close();
    };
  }, []);

  // 回合完成（任意会话 running true→false，含后台并行的会话）
  useEffect(() => {
    const prev = prevRunning.current;
    const next = { ...runningSessions };
    for (const [file, running] of Object.entries(next)) {
      if (prev[file] && !running) {
        const title = sessions.find((s) => s.path === file)?.title;
        notify(title ? `Pi · ${title}` : "Pi", "回复已完成");
      }
    }
    prevRunning.current = next;
  }, [runningSessions, sessions, notify]);

  // 后台任务结束（running → done/failed）
  useEffect(() => {
    const prev = prevTasks.current;
    for (const task of tasks) {
      if (prev.get(task.id) === "running" && task.status !== "running") {
        const label = task.label ? `后台任务 ${task.label}` : "后台任务";
        notify(`Pi · ${label}`, task.status === "done" ? "执行完成" : "执行失败");
      }
    }
    prevTasks.current = new Map(tasks.map((t) => [t.id, t.status]));
  }, [tasks, notify]);
}
