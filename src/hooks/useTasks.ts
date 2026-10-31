import { useCallback, useEffect, useState } from "react";
import type { RpcEvent, TaskInfo } from "@/lib/pi";

/**
 * Background shell tasks live in the main process, so this list survives
 * session switches and keeps streaming while the agent keeps talking.
 */
export function useTasks() {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  useEffect(() => {
    window.pi.term.hosts().then(setHosts).catch(() => setHosts([]));
  }, []);

  const refresh = useCallback(async () => {
    setTasks(await window.pi.term.list());
  }, []);

  useEffect(() => {
    refresh();
    return window.pi.onEvent((rec: RpcEvent) => {
      // Tasks started by the agent (pi-bg) arrive as term_add pushes; silent
      // ones never emit output events, so this is their only announcement.
      if (rec.type === "term_add") {
        const task = rec.task;
        if (!task) return;
        setTasks((list) =>
          list.some((t) => t.id === task.id) ? list : [task, ...list].slice(0, 30),
        );
        return;
      }
      if (rec.type !== "term_data" && rec.type !== "term_exit") return;
      if (!rec.id) return;
      setTasks((list) => {
        // A task started outside this hook (e.g. by the agent) isn't in state yet.
        if (!list.some((t) => t.id === rec.id)) {
          queueMicrotask(refresh);
          return list;
        }
        return list.map((t) => {
          if (t.id !== rec.id) return t;
          if (rec.type === "term_data") {
            return { ...t, output: (t.output + (rec.chunk ?? "")).slice(-200_000) };
          }
          return { ...t, status: rec.code === 0 ? "done" : "failed", exitCode: rec.code ?? null };
        });
      });
    });
  }, [refresh]);

  const run = useCallback(
    async (cmd: string, cwd: string, host?: string) => {
      const res = await window.pi.term.run(cmd, cwd, undefined, host);
      const task: TaskInfo = {
        id: res.id,
        cmd,
        label: host ? `${host}: ${cmd.slice(0, 50)}` : cmd.slice(0, 60),
        cwd: res.cwd,
        status: "running",
        exitCode: null,
        startedAt: Date.now(),
        output: "",
        origin: "user",
      };
      setTasks((list) => [task, ...list].slice(0, 30));
      return task;
    },
    [],
  );

  const kill = useCallback((id: string) => window.pi.term.kill(id), []);
  const remove = useCallback(async (id: string) => {
    await window.pi.term.remove(id);
    setTasks((list) => list.filter((t) => t.id !== id));
  }, []);

  return { tasks, hosts, run, kill, remove, refresh };
}
