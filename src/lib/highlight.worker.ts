// 代码高亮 Worker：Shiki 的分词在主线程上对长代码块是明显的卡顿源（尤其回合结束
// 一次性把所有代码块着色时）。这里把 Shiki Core + Oniguruma 放进 Worker，按需
// 加载语言/主题，只把可结构化克隆的 token 数组回传给渲染层。
//
// 约定：请求/响应都走普通对象（token 里不含函数/类实例），否则 postMessage 会
// DataCloneError。grammar/theme 用动态 import，Vite 会拆成按需加载的 chunk。
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import githubDark from "shiki/themes/github-dark-dimmed.mjs";
import githubLight from "shiki/themes/github-light.mjs";

type HighlightRequest = {
  id: number;
  code: string;
  language: string;
};

type Style = { color?: string; bgColor?: string; fontStyle?: number; htmlStyle?: Record<string, string> };
type Token = { content: string; offset?: number } & Style;
type HighlightResult = {
  bg?: string;
  fg?: string;
  rootStyle?: string;
  tokens: Token[][];
};

// 只列常用语言：每个 grammar 都是独立的动态 import，没要求就不会下载。
const LANGS: Record<string, () => Promise<unknown>> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  protobuf: () => import("shiki/langs/protobuf.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  py: "python",
  golang: "go",
  rs: "rust",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  patch: "diff",
  docker: "dockerfile",
  objc: "objective-c",
  "objective-cpp": "objective-c",
  tf: "hcl",
  terraform: "hcl",
};

function canonical(language: string): string | null {
  const id = String(language ?? "").trim().toLowerCase();
  if (!id || id === "text" || id === "txt" || id === "plain" || id === "plaintext") return null;
  const target = ALIASES[id] ?? id;
  return target in LANGS ? target : null;
}

const THEME_LIGHT = "github-light";
const THEME_DARK = "github-dark-dimmed";

// 长会话里同一段代码会在虚拟滚动/重渲染时反复请求；缓存结果省掉重复分词。
const CACHE_MAX = 120;
const cache = new Map<string, HighlightResult>();

let highlighterPromise: Promise<any> | null = null;
const loaded = new Set<string>();

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [],
      // wasm 是 inlined 的（shiki/wasm），Worker 里不需要额外 fetch
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(hl: any, language: string) {
  if (loaded.has(language)) return;
  const loader = LANGS[language];
  if (!loader) throw new Error(`unsupported language: ${language}`);
  const mod: any = await loader();
  await hl.loadLanguage(mod.default ?? mod);
  loaded.add(language);
}

function styleOf(token: any): Record<string, string> | undefined {
  const light = token?.variants?.light ?? {};
  const dark = token?.variants?.dark ?? {};
  const style: Record<string, string> = {};
  if (light.color) style.color = light.color;
  if (dark.color) style["--shiki-dark"] = dark.color;
  if (light.bgColor) style["background-color"] = light.bgColor;
  if (dark.bgColor) style["--shiki-dark-bg"] = dark.bgColor;
  // Shiki FontStyle：1 italic / 2 bold / 4 underline
  const fs = Number(light.fontStyle ?? 0);
  if (fs & 1) style.fontStyle = "italic";
  if (fs & 2) style.fontWeight = "bold";
  if (fs & 4) style.textDecoration = "underline";
  return Object.keys(style).length ? style : undefined;
}

async function highlight(code: string, language: string): Promise<HighlightResult> {
  const key = `${language}\u0000${code}`;
  const cached = cache.get(key);
  if (cached) {
    // LRU：命中就移到队尾
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const hl = await getHighlighter();
  await ensureLanguage(hl, language);
  const lines = hl.codeToTokensWithThemes(code, {
    lang: language,
    themes: { light: THEME_LIGHT, dark: THEME_DARK },
  });
  const lightTheme = hl.getTheme(THEME_LIGHT);
  const darkTheme = hl.getTheme(THEME_DARK);
  const result: HighlightResult = {
    bg: lightTheme.bg,
    fg: lightTheme.fg,
    // pre 的 dark:bg-[var(--shiki-dark-bg,…)] 靠这个变量
    rootStyle: darkTheme.bg ? `--shiki-dark-bg: ${darkTheme.bg};` : undefined,
    tokens: (lines as any[]).map((line) =>
      (line ?? []).map((token: any) => {
        const htmlStyle = styleOf(token);
        return htmlStyle
          ? { content: token.content, offset: token.offset, htmlStyle }
          : { content: token.content, offset: token.offset };
      }),
    ),
  };
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return result;
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (event) => {
  const { id, code, language } = event.data ?? {};
  if (typeof id !== "number" || typeof code !== "string") return;
  const lang = canonical(language ?? "");
  if (!lang) {
    ctx.postMessage({ id, result: null });
    return;
  }
  highlight(code, lang)
    .then((result) => ctx.postMessage({ id, result }))
    .catch(() => ctx.postMessage({ id, result: null }));
};
