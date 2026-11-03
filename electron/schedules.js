// 定时任务：每天 HH:MM 触发一次，把预置 prompt 派给并行 agent 板执行，
// 完成走既有通知。存储在 userData/schedules.json，主进程每 30s 对表。
import fs from "node:fs";
import path from "node:path";
import { logLine } from "./logs.js";

export function createScheduler({ userDataDir, fire }) {
  const file = () => path.join(userDataDir, "schedules.json");

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file(), "utf8")) ?? { schedules: [] };
    } catch {
      return { schedules: [] };
    }
  };

  const write = (data) => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file(), `${JSON.stringify(data, null, 2)}\n`);
  };

  const list = () => read().schedules ?? [];

  const save = (schedule) => {
    // { id?, name, time: "HH:MM", cwd, message, enabled }
    if (!/^\d{1,2}:\d{2}$/.test(String(schedule.time ?? ""))) {
      return { ok: false, error: "时间格式应为 HH:MM" };
    }
    if (typeof schedule.message !== "string" || !schedule.message.trim()) {
      return { ok: false, error: "任务内容不能为空" };
    }
    const data = read();
    data.schedules ??= [];
    const id = schedule.id ?? `sch-${Date.now()}`;
    const next = {
      id,
      name: String(schedule.name ?? "").trim() || `定时 ${schedule.time}`,
      time: schedule.time,
      cwd: typeof schedule.cwd === "string" ? schedule.cwd : "",
      message: schedule.message,
      enabled: schedule.enabled !== false,
      lastRun: schedule.lastRun ?? null,
    };
    const idx = data.schedules.findIndex((s) => s.id === id);
    if (idx === -1) data.schedules.push(next);
    else data.schedules[idx] = next;
    write(data);
    return { ok: true, schedule: next };
  };

  const remove = (id) => {
    const data = read();
    data.schedules = (data.schedules ?? []).filter((s) => s.id !== id);
    write(data);
    return { ok: true };
  };

  // 对表：本地时区的今天日期作去重键
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };

  const tick = () => {
    const now = new Date();
    const hhmm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
    const today = todayKey();
    for (const s of list()) {
      if (!s.enabled) continue;
      if (s.time !== hhmm) continue;
      if (s.lastRun === today) continue;
      save({ ...s, lastRun: today });
      logLine("scheduler", `触发「${s.name}」→ 并行 agent`);
      fire(s);
    }
  };

  let timer = null;
  const start = () => {
    if (timer) return;
    timer = setInterval(tick, 30_000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { list, save, remove, start, stop };
}
