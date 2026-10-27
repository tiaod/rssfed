/**
 * 正文字号（**只作用于文章正文**）。
 *
 * 作用域与「正文字体」相同：`.entry-prose`（见 main.css 的 `--reading-font-size`），
 * 不动列表、按钮与设置页本身 —— 用户要调的是读文章时的字号，界面跟着变只会让版式忽大忽小。
 *
 * 存的是**相对应用默认字号的百分比**（100 = 应用原本的大小），而不是固定 px：
 *  - 写 CSS 时换算成 rem：浏览器/系统调大默认字号（无障碍设置）时，正文跟着一起变大；
 *    写死 px 等于把用户那条偏好作废；
 *  - 「默认」有个明确的值：100% 时插件不写变量，正文落回 @theme 声明的 1rem；
 *  - 范围 80%–160%：再小中文读不动，再大一行放不下几个字。步长 5% 是「能微调、但不至于
 *    停在 103% 这种没意义的刻度」的折中。
 */

/** 滑块下限（百分比） */
export const READER_FONT_SCALE_MIN = 80
/** 滑块上限（百分比） */
export const READER_FONT_SCALE_MAX = 160
/** 滑块步长（百分比） */
export const READER_FONT_SCALE_STEP = 5

/** 没配过、或配置里是脏值时的兜底：100%（应用原本的字号） */
export const DEFAULT_READER_FONT_SCALE = 100

/**
 * 归一化：把任意值收到「区间内 + 步长上」的合法百分比。
 *
 * 非数字 / NaN 一律回退默认（localStorage 里被手改成字符串之类，不该让设置页打不开）；
 * 数字则 clamp 后吸附到最近的步长 —— 老版本调过更细的刻度（比如 103%）时能落到 105%，
 * 而不是直接丢回 100%。
 */
export function normalizeReaderFontScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_READER_FONT_SCALE
  }

  const clamped = Math.min(READER_FONT_SCALE_MAX, Math.max(READER_FONT_SCALE_MIN, value))
  const stepsFromMin = Math.round((clamped - READER_FONT_SCALE_MIN) / READER_FONT_SCALE_STEP)

  return READER_FONT_SCALE_MIN + stepsFromMin * READER_FONT_SCALE_STEP
}

/** 校验任意值是不是合法的百分比（用于读 localStorage 时过滤脏值） */
export function isReaderFontScale(value: unknown): value is number {
  return typeof value === 'number' && value === normalizeReaderFontScale(value)
}

/**
 * 字号对应的 CSS 变量值（rem）；null 表示「100%」——
 * 调用方据此**移除**变量而不是写 '1rem'，让默认值只由 CSS 里的 @theme 声明一处。
 */
export function readerFontSizeCss(value: unknown): string | null {
  const scale = normalizeReaderFontScale(value)

  if (scale === DEFAULT_READER_FONT_SCALE) {
    return null
  }

  // 85 → 0.85rem、115 → 1.15rem、160 → 1.6rem（去掉末尾多余的 0）
  const rem = (scale / 100).toFixed(2).replace(/\.?0+$/, '')

  return `${rem}rem`
}
