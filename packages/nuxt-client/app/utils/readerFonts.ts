/**
 * 阅读字体清单（**只作用于文章正文**）。
 *
 * 作用域是 `.entry-prose`（见 main.css 里的 `--font-reading`），不是全站 UI 字体：
 * 阅读器用户想换的通常是正文，把列表/按钮一起换掉只会让版式变陌生。
 *
 * 两类选项：
 *  - **系统字体**：写成「常见族名 + 通用族兜底」的字体栈。浏览器出于反指纹考虑拿不到用户
 *    装了哪些字体（`navigator.queryLocalFonts()` 只有 Chromium 桌面版支持且要授权），
 *    所以只能给候选清单，缺哪族就静默回退到栈里下一个 —— 因此每项末尾必须有
 *    serif / sans-serif 兜底，缺字体时是"换一种观感"，不是坏掉；
 *  - **自带字体（webfont）**：字形随应用分发（npm 依赖 lxgw-wenkai-screen-web），跨设备
 *    观感一致；首次选中时才下载样式与用到的分片，见 loadReaderFontCss。
 *
 * 自带字体只选**可再分发**的：霞鹜文楷是 SIL OFL 1.1，明确允许网页嵌入、子集化与
 * woff2 转换（许可与出处见 public/fonts/README.md）。
 */

/** 清单里的字体 id；未知值一律回退到 DEFAULT_READER_FONT_ID */
export type ReaderFontId = 'inherit' | 'sans' | 'serif' | 'kai' | 'wenkai'

export interface ReaderFont {
  id: ReaderFontId
  label: string
  /**
   * 字体栈；null = 跟随应用默认字体。
   *
   * 「跟随默认」用 null 而不是 'inherit'：null 让我们**不写** `--font-reading`，正文落回
   * @theme 里声明的 `var(--font-sans)`；写 'inherit' 反而会继承父元素字体，
   * 父级哪天换了字体，正文会跟着漂。
   */
  stack: string | null
}

/** 没配过、或配置里是脏值时的兜底：跟随应用默认字体 */
export const DEFAULT_READER_FONT_ID: ReaderFontId = 'inherit'

/**
 * 清单顺序即设置页里的选项顺序。
 *
 * 字体栈里的族名按「目标平台优先、通用族收底」排：
 *  - macOS / iOS：Songti SC / Kaiti SC / PingFang SC
 *  - Windows：SimSun / KaiTi / Microsoft YaHei
 *  - Linux：Noto Serif / Noto Sans CJK（发行版装了什么算什么，故排在最后）
 */
export const READER_FONTS: readonly ReaderFont[] = [
  { id: 'inherit', label: '跟随系统', stack: null },
  {
    id: 'sans',
    label: '黑体',
    stack: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  },
  {
    id: 'serif',
    label: '宋体',
    stack: '"Songti SC", SimSun, "Noto Serif CJK SC", "Source Han Serif SC", serif'
  },
  {
    id: 'kai',
    label: '楷体',
    stack: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif CJK SC", serif'
  },
  {
    id: 'wenkai',
    label: '霞鹜文楷（屏幕阅读版）',
    stack: '"LXGW WenKai GB Screen", "Kaiti SC", KaiTi, serif'
  }
]

const FONTS_BY_ID = new Map<string, ReaderFont>(READER_FONTS.map(font => [font.id, font]))

/** 校验任意值是不是清单里的字体 id（用于读 localStorage / 服务端返回值时过滤脏值） */
export function isReaderFontId(value: unknown): value is ReaderFontId {
  return typeof value === 'string' && FONTS_BY_ID.has(value)
}

/** 归一化：未知值 / undefined / 非字符串一律回退默认（不抛错，脏数据不该让设置页打不开） */
export function normalizeReaderFontId(value: unknown): ReaderFontId {
  return isReaderFontId(value) ? value : DEFAULT_READER_FONT_ID
}

/** 取出字体条目（未知 id 回退默认条目） */
export function resolveReaderFont(value: unknown): ReaderFont {
  return FONTS_BY_ID.get(normalizeReaderFontId(value)) ?? FONTS_BY_ID.get(DEFAULT_READER_FONT_ID)!
}

/**
 * 字体对应的 CSS 变量值；null 表示「跟随默认」——
 * 调用方据此**移除**变量而不是写 'inherit'（理由见 ReaderFont.stack）。
 */
export function readerFontStack(value: unknown): string | null {
  return resolveReaderFont(value).stack
}

/**
 * 自带字体对应的 CSS 入口（null = 系统字体，不需要加载）。
 *
 * 单独抽出来是为了让映射关系可测：真正的动态 import 必须写字面量，
 * 而字面量没法在单测里断言（见 loadReaderFontCss）。
 */
export function readerFontCssEntry(value: unknown): string | null {
  return normalizeReaderFontId(value) === 'wenkai'
    ? 'lxgw-wenkai-screen-web/lxgwwenkaigbscreen/result.css'
    : null
}

/**
 * 按需加载自带字体的样式。
 *
 * 动态 `import()` 是刻意的：Vite 会把这份 CSS 连同它引用的 259 个 woff2 分片切到独立
 * chunk，默认「跟随系统」的用户一个字节都不下载。路径必须写成字面量，Vite 才能静态
 * 分析出依赖（所以不能把 readerFontCssEntry() 的返回值直接丢进 import）。
 */
export async function loadReaderFontCss(value: unknown): Promise<void> {
  if (!readerFontCssEntry(value)) return
  await import('lxgw-wenkai-screen-web/lxgwwenkaigbscreen/result.css')
}
