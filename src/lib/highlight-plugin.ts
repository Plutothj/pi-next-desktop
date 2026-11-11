// Streamdown 的代码高亮插件（Worker 版）。
// Streamdown 2.x 把 Shiki 高亮拆成独立的 code plugin（`@streamdown/code`），
// 不传 `plugins.code` 时代码块只会原样渲染。这里实现同一套异步插件接口：
// highlight() 立刻返回 null（先显示原文），Worker 分词完成后走 callback 回填 token，
// 主线程完全不碰 grammar/分词。
import type { CodeHighlighterPlugin, HighlightResult } from "streamdown";

const THEMES: [string, string] = ["github-light", "github-dark-dimmed"];

// 与 Worker 的 LANGS/ALIASES 保持一致（这里只需要"是否支持"的判断）。
const LANGUAGES = [
  "javascript",
  "js",
  "mjs",
  "cjs",
  "typescript",
  "ts",
  "mts",
  "cts",
  "tsx",
  "jsx",
  "json",
  "jsonc",
  "bash",
  "sh",
  "shell",
  "shellscript",
  "zsh",
  "python",
  "py",
  "go",
  "golang",
  "rust",
  "rs",
  "java",
  "c",
  "cpp",
  "c++",
  "cc",
  "cxx",
  "csharp",
  "cs",
  "php",
  "ruby",
  "rb",
  "swift",
  "kotlin",
  "kt",
  "kts",
  "css",
  "scss",
  "sass",
  "html",
  "htm",
  "xml",
  "markdown",
  "md",
  "mdx",
  "sql",
  "yaml",
  "yml",
  "toml",
  "diff",
  "patch",
  "dockerfile",
  "docker",
  "ini",
  "lua",
  "perl",
  "r",
  "scala",
  "dart",
  "elixir",
  "erlang",
  "haskell",
  "clojure",
  "groovy",
  "makefile",
  "powershell",
  "protobuf",
  "graphql",
  "vue",
  "svelte",
  "hcl",
  "terraform",
  "tf",
  "nginx",
  "objective-c",
  "objc",
];

const supported = new Set(LANGUAGES);

const REQUEST_TIMEOUT_MS = 8_000;
// 同一段代码在虚拟滚动/重渲染时会重复请求，插件侧也缓存一份。
const RESULT_CACHE_MAX = 200;
const resultCache = new Map<string, HighlightResult>();

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { callback: (result: HighlightResult) => void; timer: ReturnType<typeof setTimeout> }
>();

function failPending() {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id: number; result: HighlightResult | null }>) => {
    const { id, result } = event.data ?? {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (result) entry.callback(result);
  };
  worker.onerror = (event) => {
    console.warn("highlight worker error:", event.message);
    failPending();
  };
  return worker;
}

function canonicalLanguage(language: string): string | null {
  const id = String(language ?? "").trim().toLowerCase();
  if (!id || !supported.has(id)) return null;
  return id;
}

export const workerCodeHighlighter: CodeHighlighterPlugin = {
  type: "code-highlighter",
  name: "shiki",
  getSupportedLanguages: () => LANGUAGES,
  getThemes: () => THEMES,
  supportsLanguage: (language) => canonicalLanguage(language) !== null,
  highlight({ code, isIncomplete, language }, callback) {
    // 流式中的最后一块代码不在这里分词：等块结束/回合结束后再走 Worker，
    // 否则每个 delta 都会产生一次永远用不上的请求。
    if (!callback || isIncomplete || !code) return null;
    const lang = canonicalLanguage(language);
    if (!lang) return null;
    const key = `${lang}\u0000${code}`;
    const cached = resultCache.get(key);
    if (cached) {
      // 放到微任务里回调：highlight 由 Streamdown 的 effect 调用，但保持异步语义，
      // 避免未来被挪进 render 时触发同步 setState。
      queueMicrotask(() => callback(cached));
      return null;
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      console.debug("highlight timeout:", lang);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, {
      timer,
      callback: (result) => {
        resultCache.set(key, result);
        if (resultCache.size > RESULT_CACHE_MAX) {
          resultCache.delete(resultCache.keys().next().value as string);
        }
        callback(result);
      },
    });
    ensureWorker().postMessage({ id, code, language: lang });
    return null;
  },
};
