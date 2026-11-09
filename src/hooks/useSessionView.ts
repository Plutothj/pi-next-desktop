import { useEffect, useState } from "react";
import { initialState, reduce, type State } from "./usePi";

/**
 * 并排窗格用的会话视图：自己订阅该会话的事件并维护一份只读状态。
 * 活动会话仍由 usePi 负责；这里只给"另一个正在看着的会话"提供实时转录。
 */
export function useSessionView(file: string, cwd?: string) {
  const [state, setState] = useState<State>(() => ({ ...initialState, sessionFile: file }));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setState(() => ({ ...initialState, sessionFile: file, cwd: cwd ?? "" }));
    setLoaded(false);

    // 先订阅再取快照：快照落地前到达的增量先攒着，最后用快照打底、
    // 事件继续叠加（避免两帧之间漏掉流式尾巴）。
    const off = window.pi.onEvent((rec) => {
      if (!alive || rec.sessionFile !== file) return;
      setState((s) => reduce(s, rec));
    });

    window.pi
      .sessionPane(file, cwd)
      .then((res) => {
        if (!alive) return;
        const st = (res.state ?? {}) as Record<string, unknown>;
        setState((s) => ({
          ...s,
          messages: res.messages ?? s.messages,
          isStreaming: Boolean(st.isStreaming),
          sessionName: (st.sessionName as string | undefined) ?? s.sessionName,
          model: (st.model as State["model"]) ?? s.model,
          thinkingLevel: String(st.thinkingLevel ?? s.thinkingLevel),
          autoCompact: Boolean((st.autoCompactionEnabled as boolean) ?? s.autoCompact),
        }));
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    return () => {
      alive = false;
      off();
      window.pi.unobserveSession(file).catch(() => null);
    };
  }, [file, cwd]);

  return { state, loaded };
}
