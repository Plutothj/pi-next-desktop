// auto 虚拟模型：写入 agent 目录的 pi 扩展（jiti 加载）。
// 用户在模型选择器里选 pi-desktop/auto + 档位 low/high：
//   low  → 最便宜的可用模型（日常问答）
//   high → 输出价最高的可用模型（当作"最强"的代理指标）
// 工具跟进/重试粘在上一个模型（pi 官方推荐语义），配置了 cost 的模型才参与
// 竞选（我们的模型设置保存时会从 models.dev 目录带回 cost）。
import fs from "node:fs";
import path from "node:path";

export const AUTO_ROUTER_SOURCE = `// 由 Pi Desktop 维护（勿手改，会被重新生成）——auto 虚拟模型路由。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "pi-desktop",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      // 工具跟进与重试粘住上一个成功模型（官方推荐语义）
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      try {
        const models = ctx.modelRegistry.getAvailable().filter((m) => m && m.provider?.id !== "pi-desktop");
        const priced = models.filter((m) => typeof m.cost?.input === "number" && m.cost.input > 0);
        const pool = priced.length ? priced : models;
        if (pool.length === 0) {
          const fallback = sticky?.model ?? ctx.model;
          return { model: fallback, thinkingLevel: "medium" };
        }
        const pick = (better: (a: typeof pool[0], b: typeof pool[0]) => typeof pool[0]) =>
          pool.reduce(better);
        const chosen =
          request.thinkingLevel === "high"
            ? pick((a, b) => ((b.cost?.output ?? 0) > (a.cost?.output ?? 0) ? b : a))
            : pick((a, b) => ((b.cost?.input ?? 0) < (a.cost?.input ?? 0) ? b : a));
        return { model: chosen, thinkingLevel: "medium" };
      } catch {
        const fallback = sticky?.model ?? ctx.model;
        return { model: fallback, thinkingLevel: "medium" };
      }
    },
  });
}
`;

export function installAutoRouter(agentDir) {
  try {
    const dir = path.join(agentDir, "extensions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "auto-router.ts");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== AUTO_ROUTER_SOURCE) fs.writeFileSync(file, AUTO_ROUTER_SOURCE);
    return file;
  } catch {
    return null;
  }
}
