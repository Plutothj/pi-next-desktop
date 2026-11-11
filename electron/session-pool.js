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

  async function ensure(file, cwd, { active = false, fresh = false } = {}) {
    const existing = slots.get(file);
    if (existing?.proc.running) {
      existing.lastActive = Date.now();
      if (active) existing.pendingDialog && replayDialog(existing);
      return existing;
    }

    const { runtime, argv } = await buildArgs(fresh ? null : file);
    const slot = {
      id: `s${++seq}`,
      file,
      cwd,
      proc: null,
      lastActive: Date.now(),
      pendingDialog: null,
      streaming: false,
      // 被并排窗格观察的会话：不在活动指针上，但仍要把完整事件转发给
      // 渲染层（观战窗格要实时看到流式输出）。
      observed: false,
      // 扩展 UI（todo widget / git 状态）：按会话缓存，切会话时整体替换，
      // 避免 A 的 todo 出现在 B 的界面里（历史 bug）。
      ui: { widgets: {}, statuses: {} },
    };
    const proc = new PiProcess({
      onRecord(rec) {
        slot.lastActive = Date.now();
        if (rec.type === "extension_ui_request") {
          // 扩展 UI 状态按会话缓存（即使后台会话也要记，切过来要能还原）。
          if (rec.method === "setWidget") {
            const key = rec.widgetKey ?? "widget";
            const lines = (rec.widgetLines ?? []).filter((line) => Boolean(line));
            if (lines.length) {
              slot.ui.widgets[key] = {
                lines,
                placement: rec.widgetPlacement === "belowEditor" ? "below" : "above",
              };
            } else {
              delete slot.ui.widgets[key];
            }
          } else if (rec.method === "setStatus") {
            const key = rec.statusKey ?? "status";
            const text = String(rec.statusText ?? "").trim();
            if (text) slot.ui.statuses[key] = text;
            else delete slot.ui.statuses[key];
          }
          // 阻塞型对话框：后台会话的暂存，切过来再弹
          if (["select", "input", "editor", "confirm"].includes(rec.method)) {
            slot.pendingDialog = rec;
            if (!isActive(slot.file)) return;
          }
        }
        if (rec.type === "agent_start") slot.streaming = true;
        else if (rec.type === "agent_settled" || rec.type === "agent_end") slot.streaming = false;
        if (!isActive(slot.file)) {
          if (!slot.observed) {
            // 后台且无人观察：完整事件不污染前台视图，但状态变化要让渲染层
            // 看见（侧栏运行指示 / 完成通知依赖它）。
            if (rec.type === "agent_start" || rec.type === "agent_settled" || rec.type === "agent_end") {
              send({ type: "session_status", sessionFile: slot.file, isStreaming: slot.streaming });
            }
            return;
          }
        }
        send({ ...rec, sessionFile: slot.file });
      },
      onExit({ code, signal }) {
        if (isActive(slot.file)) {
          send({ type: "child_exit", code, signal, sessionFile: slot.file });
        } else {
          // 后台会话进程退出：清掉运行指示，别让侧栏一直转圈
          slot.streaming = false;
          send({ type: "session_status", sessionFile: slot.file, isStreaming: false, alive: false });
        }
        // 用 slot.file（rebind 后的最新键），闭包里的 file 是 ensure 时的旧键
        if (slots.get(slot.file) === slot) slots.delete(slot.file);
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

  /** 并排窗格开始/停止观察某个会话：观察期间后台事件照常转发。 */
  function observe(file, on) {
    const slot = slots.get(file);
    if (!slot) return false;
    slot.observed = Boolean(on);
    if (on) slot.lastActive = Date.now();
    return true;
  }

  /** 会话的扩展 UI 快照（todo widget / 状态 chip），切会话时整体替换。 */
  function uiSnapshot(file) {
    const slot = slots.get(file);
    if (!slot) return { widgets: {}, statuses: {} };
    return {
      widgets: { ...slot.ui.widgets },
      statuses: { ...slot.ui.statuses },
    };
  }

  /**
   * 把活动会话的阻塞对话框暂存回它的槽：切走再切回时要重新弹出。
   * 直接从"待回答"表里丢掉是不行的——pi 会永远等一个没人回答的响应，
   * 正在跑的回合就卡死在半路（表现为"切到别的会话，这边的对话停住"）。
   */
  function stashDialog(file, rec) {
    const slot = slots.get(file);
    if (!slot || !rec) return false;
    slot.pendingDialog = rec;
    return true;
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
    const waits = [];
    for (const slot of slots.values()) waits.push(slot.proc.stop());
    slots.clear();
    if (process.env.PI_DEBUG) console.error(`[stopAll] kicked ${waits.length} procs`);
    // 全部子进程真正退出（含各自的 onSessionExit 钩子）后 resolve
    return Promise.allSettled(waits).then(() => {
      if (process.env.PI_DEBUG) console.error("[stopAll] all settled");
    });
  }

  /** 空闲回收：非活动且静默超时的会话进程停掉（文件在磁盘，切回重启即可）。 */
  function sweep() {
    const now = Date.now();
    for (const [file, slot] of slots) {
      if (isActive(file)) continue;
      // 并排窗格正在观察的会话不能被回收（用户正看着它）
      if (slot.observed) continue;
      if (now - slot.lastActive < idleMs) continue;
      slot.proc.stop();
      slots.delete(file);
    }
  }

  /**
   * 常驻进程上限：超出 max 时按 lastActive 淘汰最久未用的"空闲"槽。
   * 正在跑回合 / 并排窗格观察 / 活动会话永远不淘汰；被淘汰的会话切回时按
   * --session 重新拉起（或由悬停预热提前拉起）。
   */
  function trim(max = 8) {
    const idle = [];
    for (const [file, slot] of slots) {
      if (isActive(file) || slot.observed || slot.streaming) continue;
      idle.push([file, slot]);
    }
    const excess = slots.size - max;
    if (excess <= 0) return 0;
    idle.sort((a, b) => a[1].lastActive - b[1].lastActive);
    let stopped = 0;
    for (const [file, slot] of idle.slice(0, excess)) {
      slot.proc.stop();
      slots.delete(file);
      stopped += 1;
    }
    return stopped;
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
    observe,
    stashDialog,
    uiSnapshot,
    rebind,
    command,
    write,
    stop,
    stopAll,
    sweep,
    trim,
    isRunning: (file) => Boolean(slots.get(file)?.proc.running),
    files: () => [...slots.keys()],
    count: () => slots.size,
  };
}
