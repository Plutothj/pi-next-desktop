// Aggregated usage stats across ALL sessions, computed from the session
// files directly (no RPC): per-model tokens/cost and a per-day series.

import fs from "node:fs";
import path from "node:path";
import { sessionsRoot } from "./session-files.js";

const emptyEntry = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
});

const addUsage = (target, u) => {
  target.input += Number(u.input ?? 0);
  target.output += Number(u.output ?? 0);
  target.cacheRead += Number(u.cacheRead ?? 0);
  target.cacheWrite += Number(u.cacheWrite ?? 0);
  target.total += Number(u.totalTokens ?? 0);
  target.cost += Number(u.cost?.total ?? 0);
};

const add = (a, b) => {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite; a.total += b.total; a.cost += b.cost;
};

export function aggregateUsage(days = "all") {
  const root = sessionsRoot();
  const cutoff = days === "all" ? 0 : Date.now() - Number(days) * 86_400_000;

  const totals = emptyEntry();
  const byModel = new Map();
  const byDay = new Map();
  const sessionsWithData = new Set();
  let assistantMessages = 0;

  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { totals, byModel: [], byDay: [], sessions: 0, assistantMessages: 0 };
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let files = [];
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dirPath, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue; // nothing inside can be in range

      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const message = rec.message;
        if (message?.role !== "assistant" || !message.usage) continue;
        const ts = Number(message.timestamp ?? 0);
        if (cutoff && (!ts || ts < cutoff)) continue;

        const entry = emptyEntry();
        addUsage(entry, message.usage);
        if (entry.total === 0 && entry.cost === 0) continue; // empty usage rows

        assistantMessages += 1;
        sessionsWithData.add(file);
        add(totals, entry);

        const key = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
        const modelEntry = byModel.get(key) ?? {
          ...emptyEntry(), model: message.model ?? "unknown",
          provider: message.provider ?? "unknown", messages: 0,
        };
        add(modelEntry, entry);
        modelEntry.messages += 1;
        byModel.set(key, modelEntry);

        const day = new Date(ts || Date.now()).toLocaleDateString("sv-SE"); // YYYY-MM-DD
        const dayEntry = byDay.get(day) ?? { ...emptyEntry(), messages: 0 };
        add(dayEntry, entry);
        dayEntry.messages += 1;
        byDay.set(day, dayEntry);
      }
    }
  }

  return {
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.total - a.total),
    byDay: [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    sessions: sessionsWithData.size,
    assistantMessages,
  };
}
