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
 * 让宽高一起缩放。
 *
 * 视频嵌入另外走一条路（见 `isVideoEmbed`），因为「照抄源站尺寸」对播放器是错的两次：
 *
 * 1. **源站只说宽度、不说高度** —— B 站 / IT 之家导出的 `<iframe width="100%" allowfullscreen>`
 *    就是这样。宽度铺满了，高度却停在浏览器默认的 150px：1104 宽的阅读栏里出现一条
 *    1104×150 的横条，视频被压成一条缝。
 * 2. **源站写的是它自己窄栏里的尺寸** —— B 站每周必看给的是 `640×360`（旧版 YouTube 的
 *    默认嵌入尺寸也一样）。照抄等于把一个 640 宽的小播放器摆在 1104 宽的正文里，
 *    读者点开视频条目看到的是画面的一角。
 *
 * 两种情形都指向同一个处理：**横向视频嵌入铺满容器宽**，比例用源站声明的、没有就用 16:9。
 * 只对横向（宽 ≥ 高）生效 —— 竖版视频要保留源站尺寸，拉成 100% 宽会变成一屏高的竖条。
 * 定高嵌入（`width="100%" height="152"` 的音频条）与未知嵌入仍按源站声明缩放：
 * 前者的高度是它算好的，后者可能是投票 / 地图 / 评论区，猜比例只会制造空白。
 */

/** 宽度可解析成 px 的写法：`800`、`800px`（大小写无关，允许前后空白） */
const PX_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i

/**
 * 播放器没声明比例时的默认比例。
 *
 * 16:9 而不是 4:3：主流视频站（B 站 / YouTube / 腾讯 / 优酷）的播放器画布都是 16:9，
 * 弄错也只会多出一点上下留白，不会把画面裁掉。
 */
const DEFAULT_VIDEO_ASPECT = '16 / 9'

/**
 * 地址里带这些词就当成播放器页（只看 hostname + pathname，大小写无关）。
 *
 * **不看查询串**：`?utm_source=video`、`?video=1` 这类参数在普通页面上到处都是。
 *
 * 用子串而不是「完整路径段」匹配，是因为源站的播放器路径写法太杂：`player.bilibili.com`、
 * `youtube.com/embed/`、`bilibili.com/blackboard/html5mobileplayer.html`（`player` 前面
 * 还粘着 `html5mobile`）。宁可多认几个（代价只是「没声明高度的嵌入」多占一点高度），
 * 也别漏掉播放器 —— 漏掉就是这次要修的那个 150px 横条。
 */
const VIDEO_PATH_HINT = /player|embed|video/

/**
 * class / title / id 里出现这些词也当成播放器。
 *
 * 源站常把语义写进 class（`ithome_video bilibili`、`wp-block-embed-youtube`），而 src
 * 未必看得出是播放器（例如 `bilibili.com/blackboard/html5mobileplayer.html`，路径里只有
 * 一个连写的 `html5mobileplayer`）。属性是源站自己写的，比地址猜测更可信。
 */
const VIDEO_ATTR_HINT = /video|player|embed/i

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
 * 这个 iframe 是不是一个视频播放器（**只用于尺寸启发式**，与放行与否无关）。
 *
 * 放行由 utils/iframePolicy 决定：没通过白名单的 iframe 根本走不到这里，所以这个判断
 * 不会扩大攻击面。它只回答「要不要铺满容器宽 / 要不要补 16:9」。
 *
 * 判据从强到弱：
 * 1. `allowfullscreen` / `allow="… fullscreen …"` —— 绝大多数播放器都要全屏；
 * 2. class / title / id 里的 video / player / embed（源站自己写明的语义）；
 * 3. 地址的 hostname + pathname 命中播放器路径。解析不了的地址一律不当播放器。
 *
 * 注意音频条（Spotify / SoundCloud）也会命中这里 —— 但它们都写死高度，落到
 * applyResponsiveIframeSizing 里「定高嵌入」那条分支，不会被撑成 16:9。
 */
export function isVideoEmbed(el: Element): boolean {
  if (el.hasAttribute('allowfullscreen')) return true
  if (el.getAttribute('allow')?.toLowerCase().includes('fullscreen')) return true

  const attrs = `${el.getAttribute('class') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('id') ?? ''}`
  if (VIDEO_ATTR_HINT.test(attrs)) return true

  const src = el.getAttribute('src')?.trim()
  if (!src) return false
  try {
    const url = new URL(src)
    return VIDEO_PATH_HINT.test(`${url.hostname}${url.pathname}`.toLowerCase())
  } catch {
    return false
  }
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

  // 源站常把「响应式嵌入」交给自己的 JS：Ghost 导出的 iframe 带
  // `position:absolute; top:0; left:0`，高度由它们的脚本写到外层 figure 上。
  // 那套脚本在阅读器里不存在，于是 figure 高度塌成 0、iframe 绝对定位叠在后面的正文上
  // （一篇里嵌三四个视频时全叠在同一个位置）。正文里的嵌入本来就该占一行，强制回到 static。
  style.setProperty('position', 'static', 'important')

  const width = declaredPx(el, 'width')
  const height = declaredPx(el, 'height')
  const ratio = width !== undefined && height !== undefined ? width / height : undefined

  // 源站给了**像素高度**却是百分比宽度（`width="100%" height="152"`）：这是「定高嵌入」，
  // 高度是它算好的（Spotify / SoundCloud 的音频条 152，腾讯视频的 460），宽度本来就该铺满。
  // 必须排在视频分支前面 —— 这类地址（`open.spotify.com/embed/`、`w.soundcloud.com/player/`）
  // 同样命中 isVideoEmbed，但按 16:9 撑开会变成一条 621px 高的空条。
  if (height !== undefined && width === undefined) return

  // 横向视频（宽 ≥ 高，或根本没给出比例）：铺满容器宽，按比例缩放。
  // 覆盖上面说的两种坏法：没有高度的播放器不再停在 150px；写死 640 的播放器不再缩在左边。
  if (isVideoEmbed(el) && (ratio === undefined || ratio >= 1)) {
    style.setProperty('width', '100%', 'important')
    style.setProperty('height', 'auto', 'important')
    style.setProperty(
      'aspect-ratio',
      ratio === undefined ? DEFAULT_VIDEO_ASPECT : `${width} / ${height}`,
      'important'
    )
    return
  }

  // 以下是「不该铺满」的：竖版视频 / 非视频嵌入，按源站声明缩放。
  if (width !== undefined && height !== undefined) {
    style.setProperty('width', `min(${width}px, 100%)`, 'important')
    style.setProperty('height', 'auto', 'important')
    style.setProperty('aspect-ratio', `${width} / ${height}`, 'important')
    return
  }

  // 没声明高度、也不是横向视频：只兜宽度，不替源站猜高度。
  // 给未知嵌入猜一个比例，可能把投票 / 地图 / 评论区撑成一整屏空白。
  // 非像素宽（百分比 / calc）交给浏览器，不硬套成 px。
  if (width !== undefined) style.setProperty('width', `min(${width}px, 100%)`, 'important')
}
