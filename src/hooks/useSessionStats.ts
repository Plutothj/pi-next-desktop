import { useCallback, useEffect, useRef, useState } from "react";

export type SessionStats = {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
};

/** Session token/cost/context stats, re-read after every agent turn. */
export function useSessionStats(_sessionFile: string | undefined, streaming: boolean) {
  const [stats, setStats] = useState<SessionStats | null>(null);

  const refresh = useCallback(async () => {
    const res = (await window.pi
      .send({ type: "get_session_stats" })
      .catch(() => null)) as SessionStats | null;
    if (res && typeof res === "object" && "tokens" in res) setStats(res);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The agent's usage changes during a turn; settle is the cheap moment to re-read.
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current && !streaming) refresh();
    prevStreaming.current = streaming;
  }, [streaming, refresh]);

  return { stats, refresh };
}
