// 并行 agent 任务板：派生独立的 pi RPC 子进程在后台干活（各 own 会话），
// 主聊天不受影响。完成时推送 agent_update + ui_notify，可一键转正为主会话。
// v1 是"发射后可观察"：卡片显示状态与输出尾巴，实时切换留 v2。

import { PiProcess, PI_BG_INSTRUCTIONS, probeCli, resolveRuntime } from "./pi-process.js";
import { logLine } from "./logs.js";
import path from "node:path";

let nextId = 1;

export function createAgentBoard({ send, termEnv, agentDir }) {
  const agents = new Map();

  const push = (agent) => {
    send({ type: "agent_update", agent: publicAgent(agent) });
  };

  const publicAgent = (a) => ({
    id: a.id,
    name: a.name,
    cwd: a.cwd,
    status: a.status, // running | done | failed | error
    startedAt: a.startedAt,
    endedAt: a.endedAt ?? null,
    tail: a.log.slice(-400),
    sessionFile: a.sessionFile ?? null,
  });

  async function start({ name, cwd, message }) {
    const id = `agent-${nextId++}`;
    const rt = resolveRuntime();
    const probe = await probeCli(rt);
    const argv = [rt.cli, "--mode", "rpc"];
    if (probe.appendPrompt) argv.push("--append-system-prompt", PI_BG_INSTRUCTIONS);

    const agent = {
      id,
      name: name || `任务 ${id}`,
      cwd,
      status: "running",
      startedAt: Date.now(),
      log: "",
      sessionFile: null,
      proc: null,
    };
    agents.set(id, agent);

    const proc = new PiProcess({
      onRecord(rec) {
        handleRecord(agent, rec);
      },
      onExit({ code }) {
        if (agents.get(id) !== agent) return;
        agent.status = agent.status === "running" ? (code === 0 || agent.settled ? "done" : "failed") : agent.status;
        agent.endedAt = Date.now();
        push(agent);
      },
      onStderr(data) {
        recordStderr(agent, data);
      },
    });
    agent.proc = proc;
    // env 与主 pi 一致（隔离目录 + pi-bg 桥）
    proc.start({
      node: rt.node,
      argv,
      cwd,
      env: termEnv(),
    });

    // prompt 前先等 boot：轮询 get_state 直到有 model 或超时
    void (async () => {
      try {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 400));
          const st = await proc.command({ type: "get_state" }, 5000).catch(() => null);
          if (st?.data?.model) break;
        }
        const res = await proc.command({ type: "prompt", message }, 10_000).catch((err) => ({ error: err.message }));
        if (res?.error) throw new Error(res.error);
      } catch (err) {
        agent.status = "error";
        agent.log += `\n[启动失败] ${err.message}`;
        push(agent);
        proc.stop();
        return;
      }
      push(agent);
    })();

    push(agent);
    return publicAgent(agent);
  }

  function recordStderr(agent, data) {
    const line = data.trimEnd().slice(0, 300);
    if (line) logLine(`agent:${agent.id}`, line);
  }

  async function handleRecord(agent, rec) {
    // 文本尾巴：message_update 的 text_delta
    if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") {
      agent.log += rec.assistantMessageEvent.delta ?? "";
      return;
    }
    // agent_settled：pi 不会再自动继续 → 任务完成
    if (rec.type === "agent_settled") {
      agent.settled = true;
      agent.status = "done";
      agent.endedAt = Date.now();
      // 拿会话文件供"转正"，然后收摊
      const st = await agent.proc?.command({ type: "get_state" }, 5000).catch(() => null);
      if (st?.data?.sessionFile) agent.sessionFile = st.data.sessionFile;
      send({
        type: "ui_notify",
        message: `并行任务「${agent.name}」已完成`,
        notifyType: "info",
      });
      push(agent);
      agent.proc?.stop();
      return;
    }
    if (rec.type === "message_end") push(agent);
    if (rec.type === "error") {
      agent.log += `\n[错误] ${rec.message ?? ""}`;
    }
  }

  function stop(id) {
    const agent = agents.get(id);
    if (!agent) return { ok: false, error: "任务不存在" };
    agent.proc?.stop();
    agent.status = "failed";
    agent.endedAt = Date.now();
    push(agent);
    return { ok: true };
  }

  function list() {
    return [...agents.values()].slice(-30).map(publicAgent);
  }

  function stopAll() {
    for (const agent of agents.values()) {
      if (agent.status === "running") agent.proc?.stop();
    }
  }

  return { start, stop, list, stopAll, agentDirHint: agentDir };
}
