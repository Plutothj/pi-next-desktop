import { useEffect, useRef } from "react";
import type { TaskInfo } from "@/lib/pi";

// 窗口不在前台（托盘/最小化/失焦）时，用系统通知播报回合完成与后台任务结束；
// 点击通知唤起窗口。前台使用时不打扰。
export function useNotifications(streaming: boolean, sessionName: string | undefined, tasks: TaskInfo[]) {
  const prevStreaming = useRef(false);
  const prevTasks = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  }, []);

  const notify = (title: string, body: string) => {
    if (document.hasFocus()) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.pi.showWindow();
      window.focus();
      n.close();
    };
  };

  // 回合完成（streaming true→false）
  useEffect(() => {
    const was = prevStreaming.current;
    prevStreaming.current = streaming;
    if (was && !streaming) {
      notify(sessionName ? `Pi · ${sessionName}` : "Pi", "回复已完成");
    }
  }, [streaming, sessionName]);

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
  }, [tasks]);
}
