import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelInfo } from "@/lib/pi";

export type ModelRef = { provider: string; id: string };

export type DualModelConfig = {
  enabled: boolean;
  planner: ModelRef | null;
  executor: ModelRef | null;
};

// 双模型配置按会话存储：A 会话开着双模型，去 B 会话用单模型不能把 A 的配置
// 改掉。旧版本只有一个全局键，这里做一次性迁移。
const KEY_PREFIX = "pi-desktop-dual-model:";
const LEGACY_KEY = "pi-desktop-dual-model";
const MIGRATED_KEY = "pi-desktop-dual-model-migrated-v1";
const DEFAULTS_KEY = "pi-desktop-dual-model-defaults";

const sessionKey = (file: string) => `${KEY_PREFIX}${file}`;

function readDefaults(): { planner: ModelRef | null; executor: ModelRef | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? "");
    if (raw) return { planner: raw.planner ?? null, executor: raw.executor ?? null };
  } catch {}
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "");
    return { planner: legacy?.planner ?? null, executor: legacy?.executor ?? null };
  } catch {
    return { planner: null, executor: null };
  }
}

function normalize(raw: unknown): DualModelConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<DualModelConfig>;
  return {
    enabled: Boolean(value.enabled),
    planner: value.planner ?? null,
    executor: value.executor ?? null,
  };
}

function readFor(file?: string): DualModelConfig {
  const defaults = readDefaults();
  if (!file) return { enabled: false, ...defaults };
  try {
    const raw = JSON.parse(localStorage.getItem(sessionKey(file)) ?? "");
    const config = normalize(raw);
    if (config) return config;
  } catch {}
  // 旧版本的全局配置只迁移给第一个打开的会话，新会话默认单模型。
  if (!localStorage.getItem(MIGRATED_KEY)) {
    localStorage.setItem(MIGRATED_KEY, "1");
    try {
      const legacy = normalize(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? ""));
      if (legacy) {
        localStorage.setItem(sessionKey(file), JSON.stringify(legacy));
        return legacy;
      }
    } catch {}
  }
  return { enabled: false, ...defaults };
}

function persist(file: string | undefined, config: DualModelConfig) {
  if (file) localStorage.setItem(sessionKey(file), JSON.stringify(config));
  const defaults = readDefaults();
  localStorage.setItem(
    DEFAULTS_KEY,
    JSON.stringify({
      planner: config.planner ?? defaults.planner,
      executor: config.executor ?? defaults.executor,
    }),
  );
}

/** Plan-with-one-model, execute-with-another; configuration is per session. */
export function useDualModel(sessionFile?: string) {
  const fileRef = useRef(sessionFile);
  const [config, setConfig] = useState<DualModelConfig>(() => readFor(sessionFile));

  // 切会话时加载该会话自己的配置；A 会话的设置不受 B 会话改动影响。
  useEffect(() => {
    if (fileRef.current === sessionFile) return;
    fileRef.current = sessionFile;
    setConfig(readFor(sessionFile));
  }, [sessionFile]);

  const update = useCallback((patch: Partial<DualModelConfig>) => {
    setConfig((current) => {
      const next = { ...current, ...patch };
      persist(fileRef.current, next);
      return next;
    });
  }, []);

  const setEnabled = useCallback((enabled: boolean) => update({ enabled }), [update]);
  const setPlanner = useCallback((planner: ModelRef | null) => update({ planner }), [update]);
  const setExecutor = useCallback((executor: ModelRef | null) => update({ executor }), [update]);

  const find = useCallback(
    (models: ModelInfo[], ref: ModelRef | null) =>
      ref ? models.find((m) => m.provider === ref.provider && m.id === ref.id) : undefined,
    [],
  );

  return { config, setEnabled, setPlanner, setExecutor, find };
}
