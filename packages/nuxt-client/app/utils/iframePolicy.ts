/**
 * 正文 <iframe> 的嵌入策略（渲染层过滤规则，纯函数，可单测）。
 *
 * 正文里的 iframe 默认一律移除，只有满足下面任一条才保留：
 *
 * 1. **与订阅源同源** —— iframe 的 origin 等于订阅源站点/源地址/条目原文的 origin。
 *    订阅源作者嵌自己站点的播放器是最常见的情形，值得自动放行，不必让管理员逐个登记。
 * 2. **命中管理员维护的地址前缀白名单** —— 国内外常见视频站的播放器地址（见后端
 *    `DEFAULT_IFRAME_WHITELIST`）。用前缀而不是主机名，是为了把授权收在播放器页面上。
 *
 * 另外两条硬约束（与白名单无关，任何来源都不放行）：
 * - 只接受 http/https，`javascript:` / `data:` / `blob:` 一律拒绝；
 * - **不放行阅读器自身的 origin**：同源 iframe 能盖在阅读器 UI 上做点击劫持，
 *   而正文里嵌阅读器自己没有任何正当用途。
 *
 * 关于信任边界：参与「同源」比较的 siteUrl / feedUrl / entry.url 都来自订阅源自身，
 * 恶意源本来就能把它们指到任意站点。所以这条规则是「恢复原文嵌入效果」的可用性启发式，
 * 不是硬信任边界；真正的边界是 iframe 跨源、拿不到阅读器 DOM，且脚本/事件属性已被
 * DOMPurify 剥掉。第三方嵌入则另外受管理员白名单约束。
 *
 * 相对地址（`/player.html`、`//cdn/...`）先按条目原文地址解析成绝对地址：
 * 浏览器只会拿**阅读器自身**的 origin 去补全它们，那等于把阅读器自己嵌进来 ——
 * 所以必须在净化阶段改写成绝对地址（见 useSafeHtml 的 hook）。
 */

/** 一份用于单条正文的嵌入策略 */
export interface IframeEmbedPolicy {
  /** 相对 iframe 地址的解析基准（通常是条目原文地址 entry.url） */
  base?: string
  /** 允许的第三方 iframe 地址前缀（小写，形如 `https://www.youtube.com/embed/`） */
  urlPrefixes: string[]
  /** 与订阅源同源的 origin（小写，不含尾斜杠） */
  feedOrigins: string[]
  /** 阅读器自身 origin：永不作为可嵌入目标 */
  appOrigin?: string
}

/** 构造策略时的输入：订阅源上下文 + 管理员白名单 */
export interface IframeSourceContext {
  /** 订阅源站点地址（feed.siteUrl） */
  siteUrl?: string | null
  /** 源 XML 地址（feed.feedUrl） */
  feedUrl?: string | null
  /** 条目原文地址（entry.url），同时用作相对地址的解析基准 */
  entryUrl?: string | null
  /** 管理员维护的 iframe 地址前缀白名单（未配置时为空） */
  urlPrefixes?: string[] | null
}

/** 取 URL 的 origin；非法或非 http(s) 返回 null */
function toOrigin(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/** 归一化白名单条目（与服务端 normalizeIframeWhitelist 同一套规则）；非法条目直接丢弃 */
function normalizePrefix(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 由订阅源上下文构造策略。
 * `appOrigin` 由调用方传入（浏览器里是 `window.location.origin`），便于在测试中固定。
 */
export function buildIframePolicy(
  context: IframeSourceContext,
  appOrigin?: string
): IframeEmbedPolicy {
  const normalizedAppOrigin = appOrigin?.toLowerCase()

  const feedOrigins: string[] = []
  for (const candidate of [context.siteUrl, context.feedUrl, context.entryUrl]) {
    const origin = toOrigin(candidate)
    // 不把阅读器自身算作「订阅源同源」：否则订阅到本站的源就能把阅读器嵌进正文
    if (!origin || origin === normalizedAppOrigin) continue
    if (!feedOrigins.includes(origin)) feedOrigins.push(origin)
  }

  const prefixes: string[] = []
  for (const item of context.urlPrefixes ?? []) {
    if (typeof item !== 'string') continue
    const prefix = normalizePrefix(item)
    if (prefix && !prefixes.includes(prefix)) prefixes.push(prefix)
  }

  const base = (context.entryUrl || context.siteUrl || context.feedUrl || '').trim() || undefined

  return {
    base,
    urlPrefixes: prefixes,
    feedOrigins,
    appOrigin: normalizedAppOrigin
  }
}

/**
 * 判定单个 iframe 的 src 能否嵌入，返回**改写后的绝对地址**；不允许时返回 null。
 *
 * 返回值而不是布尔值：相对地址必须由调用方写回 DOM（见文件头注释），
 * 判定和改写是同一次决策，拆开容易只做一半。
 */
export function resolveIframeSrc(src: string | null | undefined, policy: IframeEmbedPolicy): string | null {
  const raw = src?.trim()
  // 没有 src 的 iframe（含只剩 srcdoc 的）不是可嵌入内容，直接丢掉，避免留下空白块
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw, policy.base)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const origin = url.origin.toLowerCase()
  if (policy.appOrigin && origin === policy.appOrigin) return null

  if (policy.feedOrigins.includes(origin)) return url.href

  const href = url.href.toLowerCase()
  if (policy.urlPrefixes.some(prefix => href.startsWith(prefix))) return url.href

  return null
}
