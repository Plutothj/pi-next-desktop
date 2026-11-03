// 多会话会话池：每个会话文件一个独立 pi 进程，切会话只切"视图"，
// 不再用 pi 的 switch_session（那个换掉当前会话，正在跑的回合被打断）。
//
// 设计要点：
// - 只有「活动会话」的事件转发给渲染层；后台会话进程继续跑，切回来时用
//   get_state/get_messages 重新同步即可（会话文件持续落盘，不丢）。
// - 后台会话弹的扩展对话框暂存，切到该会话时重放，不会卡死在前台。
// - 空闲回收：非活动且超时的会话进程停掉，切回时按 --session 重新拉起。

import { PiProcess } from "./pi-process.js";

export function createSessionPool({ send, makeEnv, buildArgs, activeKey, idleMs = 10 * 60 * 1000 }) {
  const slots = new Map(); // key -> slot
  let seq = 0;

  const isActive = (file) => activeKey() === file;

  async function ensure(file, cwd, { active = false } = {}) {
    const existing = slots.get(file);
    if (existing?.proc.running) {
      existing.lastActive = Date.now();
      if (active) existing.pendingDialog && replayDialog(existing);
      return existing;
    }

    const { runtime, argv } = await buildArgs(file);
    const slot = {
      id: `s${++seq}`,
      file,
      cwd,
      proc: null,
      lastActive: Date.now(),
      pendingDialog: null,
    };
    const proc = new PiProcess({
      onRecord(rec) {
        slot.lastActive = Date.now();
        if (rec.type === "extension_ui_request") {
          // 阻塞型对话框：后台会话的暂存，切过来再弹
          if (["select", "input", "editor", "confirm"].includes(rec.method)) {
            slot.pendingDialog = rec;
            if (!isActive(slot.file)) return;
          }
        }
        if (!isActive(slot.file)) return; // 后台会话：静默，不污染前台视图
        send({ ...rec, sessionFile: slot.file });
      },
      onExit({ code, signal }) {
        if (isActive(slot.file)) send({ type: "child_exit", code, signal, sessionFile: slot.file });
        if (slots.get(file) === slot) slots.delete(file);
      },
      onStderr(data) {
        process.stderr.write(data);
      },
    });
    slot.proc = proc;
    slots.set(file, slot);
    proc.start({ node: runtime.node, argv, cwd, env: makeEnv(runtime) });
    return slot;
  }

  function replayDialog(slot) {
    const rec = slot.pendingDialog;
    if (!rec) return;
    slot.pendingDialog = null;
    send({ type: "extension_ui_request", ...rec, sessionFile: slot.file });
  }

  /** 切活动会话：后台的暂存对话框在这时补发。 */
  function activate(file) {
    const slot = slots.get(file);
    slot?.pendingDialog && replayDialog(slot);
    return slot ?? null;
  }

  async function command(file, payload) {
    const slot = slots.get(file);
    if (!slot?.proc.running) throw new Error("pi 未运行");
    slot.lastActive = Date.now();
    return slot.proc.command(payload);
  }

  function write(file, payload) {
    const slot = slots.get(file);
    if (!slot) return false;
    slot.lastActive = Date.now();
    return slot.proc.write(payload);
  }

  function stop(file) {
    const slot = slots.get(file);
    if (!slot) return;
    slot.proc.stop();
    slots.delete(file);
  }

  function stopAll() {
    for (const slot of slots.values()) slot.proc.stop();
    slots.clear();
  }

  /** 空闲回收：非活动且静默超时的会话进程停掉（文件在磁盘，切回重启即可）。 */
  function sweep() {
    const now = Date.now();
    for (const [file, slot] of slots) {
      if (isActive(file)) continue;
      if (now - slot.lastActive < idleMs) continue;
      slot.proc.stop();
      slots.delete(file);
    }
  }

  /** 把槽从旧键迁移到新键（新会话落盘后 pi 才分配文件路径）。 */
  function rebind(oldKey, newKey) {
    const slot = slots.get(oldKey);
    if (!slot || oldKey === newKey) return slot ?? null;
    slots.delete(oldKey);
    slot.file = newKey;
    slots.set(newKey, slot);
    return slot;
  }

  return {
    ensure,
    activate,
    rebind,
    command,
    write,
    stop,
    stopAll,
    sweep,
    isRunning: (file) => Boolean(slots.get(file)?.proc.running),
    files: () => [...slots.keys()],
    count: () => slots.size,
  };
}
