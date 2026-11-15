/**
 * 正文 <iframe> 的响应式尺寸（净化阶段补内联样式，纯函数，可单测）。
 *
 * 为什么必须在净化时算：<iframe> 按规范**没有内在宽高比**，`width`/`height` 属性对浏览器
 * 来说只是 CSS 尺寸的初值。于是源站写 `width="800"` 的视频在手机上就是 800px 宽，
 * 而 iframe 是替换元素，`overflow-wrap` 对它无效 —— 正文容器被整个顶出视口，整页横向滚动。
 *
 * 只靠 CSS 也补不回来：
 * - `max-width: 100%` 能把宽度压到容器宽，但 `height` 还停在 500px，播放器被拉成竖条；
 * - 给 iframe 写 `height: auto`（img/video 用的那条规则）又没有比例可依，会塌成浏览器
 *   默认的 150px 高横条。
 *
 * 所以只能在这一层把源站声明过的宽高换算成 `aspect-ratio`，宽度改成 `min(声明值, 100%)`，
 * 让宽高一起缩放。源站没声明尺寸的 iframe 一律不动 —— 保持浏览器默认 300×150，
 * 不替它猜「该占满一行」。
 */

/** 宽度可解析成 px 的写法：`800`、`800px`（大小写无关，允许前后空白） */
const PX_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i

/** 把属性/内联样式里的尺寸读成像素数；百分比、calc()、缺省都当没声明 */
function toPx(raw: string | null | undefined): number | undefined {
  const match = raw ? PX_PATTERN.exec(raw.trim()) : null
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 先读属性（最常见），再退回内联样式（`style="width:800px"` 这种导出） */
function declaredPx(el: Element, name: 'width' | 'height'): number | undefined {
  return toPx(el.getAttribute(name)) ?? toPx((el as HTMLElement).style.getPropertyValue(name))
}

/**
 * 给一个已通过白名单的 <iframe> 补响应式尺寸（同步，注入前调用）。
 *
 * 尺寸类属性一律用 `!important` 写内联：源站也常写 `width: 800px !important`，
 * 不加优先级的声明会输给它，iframe 照样撑破容器 —— 这里的目标是「绝不横溢」。
 */
export function applyResponsiveIframeSizing(el: Element): void {
  const style = (el as HTMLElement).style

  // 兜底与防 1px：iframe 默认 content-box，边框会把宽度顶出容器（表现为整页横向滚动）
  style.setProperty('max-width', '100%', 'important')
  style.setProperty('box-sizing', 'border-box', 'important')

  const width = declaredPx(el, 'width')
  if (width === undefined) return
  style.setProperty('width', `min(${width}px, 100%)`, 'important')

  // 高度没声明就不动它：没有比例可依时 `height: auto` 会把 iframe 压成 150px 的横条，
  // 不如保留源站的意图（浏览器默认高度），宽度这一半已经不会再溢出
  const height = declaredPx(el, 'height')
  if (height === undefined) return

  style.setProperty('height', 'auto', 'important')
  style.setProperty('aspect-ratio', `${width} / ${height}`, 'important')
}
