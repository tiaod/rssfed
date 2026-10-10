import http from "node:http"
import https from "node:https"
import { parseFeed } from "feedsmith"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { rewriteRssHubUrl } from "./rsshub"

/**
 * 抓取专用代理（只作用于订阅抓取与图片缓存）。
 *
 * 故意**不读 HTTP_PROXY / HTTPS_PROXY**：那两个是进程级惯例变量，axios（nano 访问 CouchDB）、
 * AWS SDK、undici 等库都会自动认，一设就把 CouchDB / S3 / ActivityPub 的请求也一起拖进代理，
 * 排查起来非常隐蔽。所以这里用独立变量，影响范围只到本模块导出的 agent 使用者：
 * 本文件的 fetchUrl 与 `images/fetch.ts`。
 *
 * RSS_FETCH_NO_PROXY 默认绕过本机（localhost/127.0.0.1/::1）——RSSHUB_BASE_URL 指向本地实例，
 * 不绕过的话本地请求会被丢给代理。
 *
 * 代理是**按域名**好坏不一的：先试代理，网络级失败再回退直连（见 fetchUrl 注释）。
 */
const PROXY = process.env.RSS_FETCH_PROXY || process.env.rss_fetch_proxy
const NO_PROXY = (process.env.RSS_FETCH_NO_PROXY || process.env.rss_fetch_no_proxy || "localhost,127.0.0.1,::1")
  .split(",").map((s) => s.trim().toLowerCase().replace(/^\[|\]$/g, "")).filter(Boolean)

// 连接级代理可复用，创建一次即可（内部有连接池）
export const httpAgent = PROXY ? new HttpProxyAgent(PROXY) : undefined
export const httpsAgent = PROXY ? new HttpsProxyAgent(PROXY) : undefined

/**
 * 该 URL 是否应走抓取代理：未配置代理时恒为 false；
 * 配置了则按 RSS_FETCH_NO_PROXY（支持 *.example.com / .example.com / host 写法）判断。
 */
export function shouldProxy(url: string): boolean {
  if (!PROXY) return false
  let host: string
  try {
    // IPv6 字面量在 URL.hostname 里带方括号，归一化掉再去比 NO_PROXY
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  if (NO_PROXY.length === 0) return true
  return NO_PROXY.every((pattern) => {
    if (pattern === "*") return false
    const p = pattern.startsWith(".") ? pattern.slice(1) : pattern
    return host !== p && !host.endsWith(`.${p}`)
  })
}

// ── 归一化后的 feed / item 类型（供 routes 和 workers 消费） ──

export interface ParsedFeed {
  title: string
  /** 站点链接 */
  link?: string
  description?: string
  image?: { url?: string }
  items: ParsedItem[]
}

export interface ParsedItem {
  title?: string
  link?: string
  guid?: string
  /** 完整正文（content:encoded 或 atom content） */
  content?: string
  /** 纯文本摘要（去除 HTML 标签） */
  contentSnippet?: string
  /** 摘要（RSS description / Atom summary） */
  summary?: string
  creator?: string
  pubDate?: string
  isoDate?: string
  categories?: string[]
  /**
   * 协议封面图（优先用于列表缩略图）：
   * media:thumbnail → media:content 图片 → 图片 enclosure → JSON Feed image。
   * 无协议字段时为 undefined（前端回退正文选图）。
   */
  coverUrl?: string
}

/**
 * 从 feedsmith 的 item 中提取协议封面图 URL（Media RSS thumbnail/content → 图片 enclosure）。
 * RSS/Atom/RDF 通用；JSON Feed 的 image 字段在 normalizeJson 单独处理。
 */
function extractProtocolCover(item: any): string | undefined {
  const mediaThumb = item.media?.thumbnails?.[0]?.url
  if (mediaThumb) return mediaThumb
  const mediaContent = (item.media?.contents ?? []).find((c: any) => c.type?.startsWith("image/"))?.url
  if (mediaContent) return mediaContent
  const imageEnclosure = (item.enclosures ?? []).find((e: any) => e.type?.startsWith("image/"))?.url
  return imageEnclosure
}

/**
 * 抓取 URL 并解析为归一化的 feed 对象。
 * 支持 HTTP/HTTPS 代理、自动跟随重定向（最多 5 次）。
 *
 * 抓取前会先将公共 RSSHub 实例（rsshub.app）改写为本地自建地址（见 rsshub.ts）。
 * 仅影响实际 HTTP 请求的地址；调用方仍以原始 URL 存储订阅与派生 feedId，
 * 从而保证订阅身份稳定。
 */
export async function parseFeedUrl(url: string): Promise<ParsedFeed> {
  const targetUrl = rewriteRssHubUrl(url)
  const xml = await fetchUrl(targetUrl)
  return parseFeedContent(xml)
}

/** 解析 feed 字符串内容（RSS/Atom/RDF/JSON 自动识别并归一化） */
export function parseFeedContent(content: string): ParsedFeed {
  const result = parseFeed(content)
  switch (result.format) {
    case "rss": return normalizeRss(result.feed)
    case "atom": return normalizeAtom(result.feed)
    case "rdf": return normalizeRss(result.feed) // RDF 结构与 RSS 类似，复用归一化
    case "json": return normalizeJson(result.feed)
    default: throw new Error(`Unsupported feed format: ${(result as { format: string }).format}`)
  }
}

// ── 格式归一化 ──

/** RSS / RDF → ParsedFeed */
function normalizeRss(feed: any): ParsedFeed {
  return {
    title: feed.title ?? "",
    link: feed.link,
    description: feed.description,
    image: feed.image ? { url: feed.image.url } : undefined,
    items: (feed.items ?? []).map(normalizeRssItem),
  }
}

function normalizeRssItem(item: any): ParsedItem {
  const content = item.content?.encoded ?? item.description ?? ""
  return {
    title: item.title,
    link: item.link,
    guid: typeof item.guid === "string" ? item.guid : item.guid?.value,
    content,
    contentSnippet: stripHtml(content),
    summary: item.description,
    creator: item.dc?.creator ?? item.authors?.[0],
    pubDate: toIso(item.pubDate),
    isoDate: toIso(item.pubDate),
    categories: item.categories?.map((c: any) => typeof c === "string" ? c : c.name),
    coverUrl: extractProtocolCover(item),
  }
}

/** Atom → ParsedFeed */
function normalizeAtom(feed: any): ParsedFeed {
  const siteLink = findAtomLink(feed.links, "alternate") ?? findAtomLink(feed.links)
  return {
    title: feed.title ?? "",
    link: siteLink,
    description: feed.subtitle,
    image: feed.logo ? { url: feed.logo } : feed.icon ? { url: feed.icon } : undefined,
    items: (feed.entries ?? []).map(normalizeAtomEntry),
  }
}

function normalizeAtomEntry(entry: any): ParsedItem {
  const link = findAtomLink(entry.links, "alternate") ?? findAtomLink(entry.links)
  const pubDate = entry.published ?? entry.updated
  const authors = entry.authors?.map((a: any) => typeof a === "string" ? a : a.name).filter(Boolean)
  return {
    title: entry.title,
    link,
    guid: entry.id,
    content: entry.content,
    contentSnippet: stripHtml(entry.content ?? entry.summary ?? ""),
    summary: entry.summary,
    creator: authors?.[0],
    pubDate: toIso(pubDate),
    isoDate: toIso(pubDate),
    categories: entry.categories?.map((c: any) => c.term),
    // Atom 无 media 扩展：封面取 rel="enclosure" 且类型为图片的链接
    coverUrl: entry.links?.find((l: any) => l.rel === "enclosure" && l.type?.startsWith("image/"))?.href,
  }
}

/** JSON Feed → ParsedFeed */
function normalizeJson(feed: any): ParsedFeed {
  return {
    title: feed.title ?? "",
    link: feed.home_page_url,
    description: feed.description,
    image: feed.icon ? { url: feed.icon } : undefined,
    items: (feed.items ?? []).map((item: any) => ({
      title: item.title,
      link: item.url,
      guid: item.id,
      content: item.content_html ?? item.content_text,
      contentSnippet: item.content_text ?? stripHtml(item.content_html ?? ""),
      summary: item.summary,
      creator: item.authors?.map((a: any) => typeof a === "string" ? a : a.name)[0],
      pubDate: toIso(item.date_published),
      isoDate: toIso(item.date_published),
      categories: item.tags,
      // JSON Feed 1.1 标准字段：条目封面图
      coverUrl: item.image,
    })),
  }
}

/** 从 Atom links 数组中按 rel 查找 href */
function findAtomLink(links: any[] | undefined, rel?: string): string | undefined {
  if (!links?.length) return undefined
  const link = rel
    ? links.find((l) => l.rel === rel)
    : links[0]
  return link?.href
}

/** 将日期值统一转为 ISO 字符串 */
function toIso(date: unknown): string | undefined {
  if (!date) return undefined
  if (date instanceof Date) return date.toISOString()
  if (typeof date === "string") {
    const d = new Date(date)
    return isNaN(d.getTime()) ? date : d.toISOString()
  }
  return undefined
}

/** 去除 HTML 标签，返回纯文本 */
function stripHtml(html: string): string {
  return html
    ?.replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .trim() || ""
}

// ── HTTP 抓取 ──

/**
 * 是否属于「换一条链路还有救」的网络级失败：连不上 / 超时 / 被重置 / DNS 失败。
 *
 * 只有这类才值得回退重试。HTTP 4xx/5xx 是对方服务器的答复，换代理也一样，不要重试
 * （否则 404 的源每次抓取都要多花一轮时间）。
 */
export function isNetworkError(err: unknown): boolean {
  const NETWORK_CODES = new Set([
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH",
    "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED", "ERR_SOCKET_CONNECTION_TIMEOUT",
  ])
  const isNetwork = (e: unknown) => {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true
    return e instanceof Error && /timeout|socket hang up|network socket disconnected/i.test(e.message)
  }
  // happy-eyeballs 下多 IP 全失败抛的是没有 message 的 AggregateError，要摊开看
  if (err instanceof AggregateError && err.errors?.length) return err.errors.some(isNetwork)
  return isNetwork(err)
}

/** 把错误压成一行可读信息（AggregateError 摊开，带 errno code） */
function describeError(err: unknown): string {
  const one = (e: unknown) => {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    const msg = e instanceof Error ? e.message : String(e)
    return code ? `${msg} (${code})` : msg
  }
  if (err instanceof AggregateError && err.errors?.length) {
    const detail = err.errors.filter((e): e is Error => e instanceof Error).map(one).join("; ")
    if (detail) return detail
  }
  return one(err)
}

/**
 * 单次取数、不重试：useProxy 决定这次走不走代理。
 * 3xx 交给外层 fetchUrl 继续跟（每跳重新判断该不该走代理）。
 */
function requestOnce(url: string, useProxy: boolean, redirects: number): Promise<string> {
  const isHttps = url.startsWith("https")
  const agent = useProxy ? (isHttps ? httpsAgent : httpAgent) : undefined

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http
    const req = mod.get(url, {
      agent,
      headers: { "User-Agent": "RSSFed/0.1.0" },
      timeout: 10000,
    }, (res) => {
      // 3xx 重定向
      if ([301, 302, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location
        res.resume()
        if (location) {
          const next = new URL(location, url).href
          fetchUrl(next, redirects + 1).then(resolve, reject)
        } else {
          reject(new Error(`Redirect without location: ${res.statusCode}`))
        }
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.on("timeout", () => req.destroy(new Error("Request timeout")))
  })
}

/**
 * 抓取 URL 返回文本内容，支持代理、代理失败回退直连、重定向。
 * 超时 10 秒，最多跟随 5 次重定向。
 *
 * 为什么要回退：代理链路好坏是**按域名**的。2026-10-10 实测（Clash 节点）：
 * openai.com / wired.com / naturecanada.ca 直连 0.5-0.7s 就通、走代理直接挂死到超时；
 * 而 news.ycombinator.com / discord.com 直连必然超时、走代理 0.4-0.9s。一刀切代理会把
 * 前一类源弄挂，所以先试代理（被墙站点快），网络级失败再回退直连。
 */
async function fetchUrl(url: string, redirects = 0): Promise<string> {
  if (redirects > 5) throw new Error("Too many redirects")
  if (!shouldProxy(url)) return requestOnce(url, false, redirects)

  try {
    return await requestOnce(url, true, redirects)
  } catch (err) {
    if (!isNetworkError(err)) throw err
    try {
      return await requestOnce(url, false, redirects)
    } catch (directErr) {
      throw new Error(`代理失败（${describeError(err)}）；直连也失败（${describeError(directErr)}）`)
    }
  }
}

/**
 * 将抓取/解析 feed 的错误格式化为可读信息。
 * Node 20+ 默认开启 happy-eyeballs（autoSelectFamily），当目标域名所有解析 IP
 * 连接均失败（如 GFW DNS 污染）时抛出的是没有 message 的 AggregateError，
 * 直接 String(err) 只会得到 "AggregateError"，必须展开 errors 数组才能看到
 * 真实原因（如 connect ETIMEDOUT / ENETUNREACH）。
 */
export function formatFeedError(url: string, err: unknown): string {
  let detail: string
  if (err instanceof AggregateError && err.errors?.length) {
    detail = err.errors
      .filter((e): e is Error => e instanceof Error)
      .map((e) => {
        const code = (e as NodeJS.ErrnoException).code
        return code ? `${e.message} (${code})` : e.message
      })
      .join("; ")
    if (!detail) detail = err.message
  } else if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    detail = code ? `${err.message} (${code})` : err.message
  } else {
    detail = String(err)
  }
  return detail ? `${url}: ${detail}` : `Unknown error fetching ${url}`
}
