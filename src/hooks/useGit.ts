import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatus } from "@/lib/pi";

/** Tracks the git branch of the active workspace. */
export function useGit(cwd: string, streaming: boolean) {
  const [git, setGit] = useState<GitStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setGit(null);
      return;
    }
    setGit(await window.pi.git.status(cwd).catch(() => null));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The agent may run git commands mid-turn; re-read once the turn settles.
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current && !streaming) refresh();
    prevStreaming.current = streaming;
  }, [streaming, refresh]);

  // Branch may change outside the app (terminal, another checkout).
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { git, refresh };
}
