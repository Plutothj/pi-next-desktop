import { useCallback, useEffect, useState } from "react";
import type { ModelInfo } from "@/lib/pi";

export type ModelRef = { provider: string; id: string };

export type DualModelConfig = {
  enabled: boolean;
  planner: ModelRef | null;
  executor: ModelRef | null;
};

const STORAGE_KEY = "pi-desktop-dual-model";

function read(): DualModelConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    return {
      enabled: Boolean(raw?.enabled),
      planner: raw?.planner ?? null,
      executor: raw?.executor ?? null,
    };
  } catch {
    return { enabled: false, planner: null, executor: null };
  }
}

/** Plan-with-one-model, execute-with-another; persisted locally. */
export function useDualModel() {
  const [config, setConfig] = useState<DualModelConfig>(read);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const setEnabled = useCallback(
    (enabled: boolean) => setConfig((c) => ({ ...c, enabled })),
    [],
  );
  const setPlanner = useCallback(
    (planner: ModelRef | null) => setConfig((c) => ({ ...c, planner })),
    [],
  );
  const setExecutor = useCallback(
    (executor: ModelRef | null) => setConfig((c) => ({ ...c, executor })),
    [],
  );

  const find = useCallback(
    (models: ModelInfo[], ref: ModelRef | null) =>
      ref ? models.find((m) => m.provider === ref.provider && m.id === ref.id) : undefined,
    [],
  );

  return { config, setEnabled, setPlanner, setExecutor, find };
}
