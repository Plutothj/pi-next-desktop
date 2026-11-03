// 并行会话的实时状态：消费主进程转发的 agent_event（按 agentId 分流），
// 事件语义与 usePi 的 reducer 一致（message_update → 流式块，message_end →
// 落消息，agent_settled → 回合结束）。
import { useEffect, useState } from "react";
import type { ContentBlock, PiMessage, RpcEvent, ToolExec } from "@/lib/pi";

export type BoardSession = {
  id: string;
  messages: PiMessage[];
  streaming: ContentBlock[] | null;
  isStreaming: boolean;
  tools: Record<string, ToolExec>;
};

const emptySession = (): BoardSession => ({
  id: "",
  messages: [],
  streaming: null,
  isStreaming: false,
  tools: {},
});

function reduceSession(s: BoardSession, rec: RpcEvent): BoardSession {
  switch (rec.type) {
    case "agent_start":
      return { ...s, isStreaming: true };
    case "agent_settled":
    case "agent_end":
      return { ...s, isStreaming: false, streaming: null };
    case "message_update":
      return s;
    case "message_end":
      if (!rec.message) return s;
      return {
        ...s,
        messages: [...s.messages, rec.message],
        streaming: rec.message.role === "assistant" ? null : s.streaming,
      };
    default:
      return s;
  }
}

// 流式块单独累积（message_update 事件带 assistantMessageEvent）
function applyDelta(blocks: ContentBlock[] | null, ev: NonNullable<RpcEvent["assistantMessageEvent"]>): ContentBlock[] {
  const i = ev.contentIndex ?? (blocks?.length ?? 0);
  const next = (blocks ?? []).slice();
  switch (ev.type) {
    case "text_start":
      next[i] = { type: "text", text: "" };
      break;
    case "text_delta":
      if (next[i]?.type === "text") next[i] = { ...next[i], text: next[i].text + (ev.delta ?? "") };
      break;
    case "thinking_start":
      next[i] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      if (next[i]?.type === "thinking")
        next[i] = { ...next[i], thinking: next[i].thinking + (ev.delta ?? "") };
      break;
    case "toolcall_start":
      next[i] = { type: "toolCall", id: ev.id ?? "", name: ev.toolName ?? "", arguments: {} };
      break;
    case "toolcall_delta":
      // 参数增量是 JSON 字符串片段，聚合为原始文本在 message_end 完成替换
      if (next[i]?.type === "toolCall") {
        const cur = Array.isArray(next[i].arguments) ? {} : next[i].arguments;
        const raw = (cur as { __raw?: string }).__raw ?? "";
        next[i] = { ...next[i], arguments: { __raw: raw + (ev.delta ?? "") } };
      }
      break;
    default:
      break;
  }
  return next.filter(Boolean);
}

export function useBoardSessions() {
  const [sessions, setSessions] = useState<Record<string, BoardSession>>({});

  useEffect(() => {
    return window.pi.onEvent((record) => {
      if (record.type === "agent_event" && record.agentId && record.rec) {
        const rec = record.rec;
        setSessions((prev) => {
          const cur = prev[record.agentId!] ?? { ...emptySession(), id: record.agentId! };
          let next = reduceSession(cur, rec);
          if (rec.type === "message_update" && rec.assistantMessageEvent) {
            next = { ...next, streaming: applyDelta(next.streaming, rec.assistantMessageEvent) };
          }
          return { ...prev, [record.agentId!]: next };
        });
      }
    });
  }, []);

  return sessions;
}
