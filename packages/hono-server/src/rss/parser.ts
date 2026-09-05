import http from "node:http"
import https from "node:https"
import { parseFeed } from "feedsmith"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { rewriteRssHubUrl } from "./rsshub"

// 代理配置来自环境变量（与 curl/node 惯例一致），兼容大小写两种写法
const PROXY_HTTP = process.env.HTTP_PROXY || process.env.http_proxy
const PROXY_HTTPS = process.env.HTTPS_PROXY || process.env.https_proxy
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)

// 连接级代理可复用，创建一次即可（内部有连接池）
export const httpAgent = PROXY_HTTP ? new HttpProxyAgent(PROXY_HTTP) : undefined
export const httpsAgent = PROXY_HTTPS ? new HttpsProxyAgent(PROXY_HTTPS) : undefined

/** 按 NO_PROXY 规则判断该 URL 是否应走代理（支持 *.example.com / .example.com / host 写法） */
export function shouldProxy(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
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
 * 抓取 URL 返回文本内容，支持代理和重定向。
 * 超时 10 秒，最多跟随 5 次重定向。
 */
function fetchUrl(url: string, redirects = 0): Promise<string> {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"))

  const isHttps = url.startsWith("https")
  const agent = shouldProxy(url)
    ? (isHttps ? httpsAgent : httpAgent)
    : undefined

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
