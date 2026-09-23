import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * RSS 正文字内的代码块高亮。
 *
 * 设计要点：
 * - 细粒度加载：只打包下面 LANG_LOADERS 里列出的语言，其余走「不认识就原样保留」。
 *   每个语言是一个独立 chunk，会被 Service Worker 预缓存（见 build/generate-sw-manifest.ts），
 *   所以语言列表不宜无限扩张。
 * - 用 JavaScript 正则引擎而不是默认的 oniguruma WASM：省掉 ~600KB 的 .wasm，
 *   代价是极少数用到 lookbehind 的语法降级为不匹配（forgiving 模式，不影响正确性）。
 * - 明暗双主题：codeToHtml 一次生成亮色内联 + --shiki-dark* 变量，
 *   暗色覆盖写在 main.css 的 .dark .entry-content .shiki 里，切换主题无需重新高亮。
 */

/** 语言定义加载器：动态 import 返回 shiki 的 LanguageInput（按需成 chunk） */
type LangModule = () => LanguageInput

/** 语言别名 → shiki 规范名（RSS 里的 class 五花八门，尽量多认几个） */
const LANG_ALIASES: Record<string, string> = {
  'js': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'node': 'javascript',
  'ts': 'typescript',
  'mts': 'typescript',
  'cts': 'typescript',
  'sh': 'shellscript',
  'bash': 'shellscript',
  'zsh': 'shellscript',
  'shell': 'shellscript',
  'console': 'shellscript',
  'py': 'python',
  'yml': 'yaml',
  'md': 'markdown',
  'htm': 'html',
  'golang': 'go',
  'rs': 'rust',
  'rb': 'ruby',
  'kt': 'kotlin',
  'cs': 'csharp',
  'c++': 'cpp',
  'docker': 'dockerfile',
  'text': 'plaintext',
  'txt': 'plaintext',
  'plain': 'plaintext'
}

/** shiki 规范名 → 语言定义（动态 import，按需成 chunk） */
const LANG_LOADERS: Record<string, LangModule> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  sql: () => import('@shikijs/langs/sql'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  markdown: () => import('@shikijs/langs/markdown'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  lua: () => import('@shikijs/langs/lua'),
  dart: () => import('@shikijs/langs/dart'),
  graphql: () => import('@shikijs/langs/graphql')
}

/** 高亮器是重量级对象，全应用共用一个 */
let highlighterPromise: Promise<HighlighterCore> | null = null
/** 已加载的语言，避免重复 loadLanguage */
const loadedLangs = new Set<string>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import('@shikijs/themes/github-light'),
      import('@shikijs/themes/github-dark')
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  return highlighterPromise
}

/** 从 class="language-ts" / class="lang-ts" 里取出语言名 */
export function detectLangFromClass(className: string): string | null {
  const matched = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(className)
  if (!matched?.[1]) return null
  const raw = matched[1].toLowerCase()
  const canonical = LANG_ALIASES[raw] ?? raw
  return LANG_LOADERS[canonical] ? canonical : null
}

/**
 * 把 root 内所有 <pre><code class="language-xxx"> 替换成高亮后的 HTML。
 * 识别不出语言、或语言不在支持列表里的代码块保持原样（.prose 会兜底样式）。
 *
 * @param isStale 内容已切换时返回 true，用于中途放弃（避免给已卸载的 DOM 白做功）
 */
export async function highlightCodeBlocks(
  root: HTMLElement,
  isStale: () => boolean = () => false
): Promise<void> {
  const codes = Array.from(root.querySelectorAll<HTMLElement>('pre > code'))
  if (codes.length === 0) return

  // 先只做语言探测：没有任何可高亮的块时，连 highlighter 都不用初始化
  const targets = codes
    .map(code => ({
      code,
      pre: code.parentElement,
      lang: detectLangFromClass(code.className) ?? detectLangFromClass(code.parentElement?.className ?? '')
    }))
    .filter((t): t is { code: HTMLElement, pre: HTMLElement, lang: string } => Boolean(t.pre && t.lang))

  if (targets.length === 0) return

  let highlighter: HighlighterCore
  try {
    highlighter = await getHighlighter()
  } catch {
    return // 高亮器初始化失败（例如 js 正则引擎不支持某语法）不影响正文展示
  }
  if (isStale()) return

  for (const { code, pre, lang } of targets) {
    if (isStale()) return
    try {
      if (!loadedLangs.has(lang)) {
        await highlighter.loadLanguage(LANG_LOADERS[lang]!())
        loadedLangs.add(lang)
      }
      if (isStale()) return

      const html = highlighter.codeToHtml(code.textContent ?? '', {
        lang,
        // 不加 defaultColor: false —— 让亮色内联在元素上，暗色由 CSS 覆盖
        themes: { light: 'github-light', dark: 'github-dark' }
      })

      const tpl = document.createElement('template')
      tpl.innerHTML = html.trim()
      const next = tpl.content.firstElementChild
      if (next) pre.replaceWith(next)
    } catch {
      // 单个代码块高亮失败就保留原始 <pre>，不牵连其他块
    }
  }
}
