import http from "node:http"
import https from "node:https"
import { promisify } from "node:util"
import zlib from "node:zlib"
import { parseFeed } from "feedsmith"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { rewriteRssHubUrl } from "./rsshub"
import { envInt } from "../env"

/**
 * 抓取专用代理（只作用于订阅抓取与图片缓存）。
 *
 * 故意**不读 HTTP_PROXY / HTTPS_PROXY**：那两个是进程级惯例变量，axios（nano 访问 CouchDB）、
 * AWS SDK、undici 等库都会自动认，一设就把 CouchDB / S3 / ActivityPub 的请求也一起拖进代理，
 * 排查起来非常隐蔽。所以这里用独立变量，影响范围只到本模块导出的 agent 使用者：
 * 本文件的 fetchFeed 与 `images/fetch.ts`。
 *
 * RSS_FETCH_NO_PROXY 默认绕过本机（localhost/127.0.0.1/::1）——RSSHUB_BASE_URL 指向本地实例，
 * 不绕过的话本地请求会被丢给代理。
 *
 * 代理链路好坏是**按域名**的（见 fetchUrl 注释），所以先走哪条路由由两项共同决定：
 *   1. `RSS_FETCH_PREFER`：没有该域名的路由记忆时先试哪条（`proxy` 默认 / `direct`）；
 *   2. 路由记忆：某域名最近走通的那条链路优先，网络级失败再切另一条（TTL 见 ROUTE_MEMO_TTL_MS）。
 * 对于「直连就能通」的源，默认的 `proxy` 偏好会把每一轮抓取都塞进计费代理；
 * 想省代理流量就设 `RSS_FETCH_PREFER=direct`，被墙的域名会在第一次失败后被记住、之后自动改走代理。
 */
const PROXY = process.env.RSS_FETCH_PROXY || process.env.rss_fetch_proxy
const NO_PROXY = (process.env.RSS_FETCH_NO_PROXY || process.env.rss_fetch_no_proxy || "localhost,127.0.0.1,::1")
  .split(",").map((s) => s.trim().toLowerCase().replace(/^\[|\]$/g, "")).filter(Boolean)
/** 没有路由记忆时先试哪条：proxy（默认，被墙站点快）| direct（省代理流量） */
const PREFER_DIRECT = (process.env.RSS_FETCH_PREFER || process.env.rss_fetch_prefer || "proxy").toLowerCase() === "direct"

// 连接级代理可复用，创建一次即可（内部有连接池）。keepAlive 让同一目标的后续请求复用
// 已建立的 CONNECT 隧道：代理链路每请求省一次 TCP+TLS 握手（2026-10-18 实测同一 host
// 连续请求 ~700ms → ~180ms/次），对「一个 tick 里几十个请求打同一个 host」收益最明显。
export const httpAgent = PROXY ? new HttpProxyAgent(PROXY, { keepAlive: true }) : undefined
export const httpsAgent = PROXY ? new HttpsProxyAgent(PROXY, { keepAlive: true }) : undefined

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
  const result = await fetchParsedFeed(url)
  // 不带 validators 时不会拿到 304；真出现说明调用方给了条件头却没处理，属于编程错误
  if (result.notModified) throw new Error("Unexpected 304 Not Modified")
  return result.feed
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

/** feed 响应的 HTTP 缓存验证器（条件请求用） */
export interface FeedValidators {
  /**
   * 验证器**来源**的 URL（一般是重定向链的最后一跳）。
   * 验证器只对它自己的资源有效：请求走到这个 URL 时才会带上，重定向中间跳不带。
   * 旧版 FeedDoc 没有这个字段时按「只对第一跳生效」处理。
   */
  url?: string
  /** 上一次响应头里的 ETag（原样保存带引号的值） */
  etag?: string
  /** 上一次响应头里的 Last-Modified */
  lastModified?: string
}

/** fetchFeed 的结果：notModified 表示服务端回了 304，正文可以一个字节都不读 */
export type FeedFetchResult =
  | { notModified: true, etag?: string, lastModified?: string, validatorUrl?: string }
  | { notModified: false, content: string, etag?: string, lastModified?: string, validatorUrl?: string }

/** fetchParsedFeed 的结果：notModified 时没有任何条目 */
export type ParsedFeedResult =
  | { notModified: true }
  | { notModified: false, feed: ParsedFeed, etag?: string, lastModified?: string, validatorUrl?: string }

const CLIENT_UA = "RSSFed/0.1.0"

/**
 * 允许服务端压缩响应。
 *
 * 订阅源是文本（XML/Atom/JSON），实测 gzip 后只剩原大小的 1/5~1/7
 * （2026-10-17：wechat2rss 658KB→134KB、youtube 28.7KB→4.1KB、macworld 536KB→95KB）。
 * Node 的 http 请求默认**不发** Accept-Encoding，所以之前每一轮抓取都在拿未压缩的全文。
 */
const ACCEPT_ENCODING = "gzip, deflate, br"
const MAX_REDIRECTS = 5

/**
 * 抓取响应体大小上限（压缩态 / 解压后）。
 *
 * 正常订阅源是几百 KB 量级（实测 gzip 后 4KB~134KB）；几十 MB 只可能是异常源、
 * 被投毒的内容或压缩炸弹。原先两处都是无上限收集，一个坏源就能把 4 个并发 worker
 * 的内存顶爆 —— 抓取失败只该是一个 job 失败，不该拖垮进程。
 */
const MAX_FEED_BYTES = envInt("MAX_FEED_BYTES", 32 * 1024 * 1024)
const MAX_FEED_DECODED_BYTES = envInt("MAX_FEED_DECODED_BYTES", 64 * 1024 * 1024)
/** 上限的展示形式（错误信息里用） */
function describeBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)}MB` : `${Math.round(bytes / 1024)}KB`
}

const gunzip = promisify(zlib.gunzip)
const inflate = promisify(zlib.inflate)
const inflateRaw = promisify(zlib.inflateRaw)
const brotliDecompress = promisify(zlib.brotliDecompress)

/** 头字段可能是 string[]；统一取第一个值 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** 解压配置：用 zlib 的 maxOutputLength 直接给解压结果设上限（比解压完再量省内存） */
const DECODE_OPTS: zlib.ZlibOptions = { maxOutputLength: MAX_FEED_DECODED_BYTES }

/** zlib 因 maxOutputLength 拒绝输出时的错误（gunzip / inflate / brotli 共用） */
function isOutputTooLarge(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === "ERR_BUFFER_TOO_LARGE" || (err instanceof Error && /maxOutputLength|output length/i.test(err.message))
}

/** 解一层 Content-Encoding；不认识的编码直接报错（比把压缩字节当 XML 解析好排查） */
async function decodeOne(body: Buffer, enc: string): Promise<Buffer> {
  try {
    if (enc === "gzip" || enc === "x-gzip") return await gunzip(body, DECODE_OPTS)
    if (enc === "deflate") {
      // 少数服务端发的是 raw deflate（无 zlib 头），先按标准 deflate 解，失败再退 raw
      try { return await inflate(body, DECODE_OPTS) } catch (err) {
        // 超限就别再试 raw 了（同样超限），直接抛给外层转成可读错误
        if (isOutputTooLarge(err)) throw err
        return await inflateRaw(body, DECODE_OPTS)
      }
    }
    if (enc === "br") return await brotliDecompress(body, DECODE_OPTS)
  } catch (err) {
    if (isOutputTooLarge(err)) {
      throw new Error(`解压后响应体超过上限（${describeBytes(MAX_FEED_DECODED_BYTES)}）`)
    }
    throw new Error(`解压响应失败（${enc}）: ${describeError(err)}`)
  }
  throw new Error(`不支持的 Content-Encoding: ${enc}`)
}

/**
 * 按 Content-Encoding 解压响应体。
 * 头里可能有多层编码（`gzip, br`），按声明的逆序逐层解。
 */
async function decodeContent(body: Buffer, encoding: string | undefined): Promise<Buffer> {
  if (!encoding) return body
  const layers = encoding
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "" && e !== "identity")
    .reverse()
  let out = body
  for (const enc of layers) out = await decodeOne(out, enc)
  return out
}

/** 一次 HTTP 取数的原始结果（body 仍是压缩态，重定向/304 时为空） */
interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/**
 * 单次取数、不重试：useProxy 决定这次走不走代理。
 * 3xx（含 304）交给外层处理；HTTP 4xx/5xx 直接 reject。
 */
function requestOnce(url: string, useProxy: boolean, extraHeaders: http.OutgoingHttpHeaders): Promise<RawResponse> {
  const isHttps = url.startsWith("https")
  const agent = useProxy ? (isHttps ? httpsAgent : httpAgent) : undefined

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http
    const req = mod.get(url, {
      agent,
      headers: { "User-Agent": CLIENT_UA, "Accept-Encoding": ACCEPT_ENCODING, ...extraHeaders },
      timeout: 10000,
    }, (res) => {
      const status = res.statusCode ?? 0
      // 3xx：重定向与 304 都没有（也不需要）响应体，交给外层判断
      if (status >= 300 && status < 400) {
        res.resume()
        resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      // 有 Content-Length 时先做一次零成本拒绝；没有的靠下面的流式累计兜底
      const declaredLength = Number(headerValue(res.headers["content-length"]))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
        res.destroy()
        reject(new Error(`响应体超过上限（${describeBytes(MAX_FEED_BYTES)}）`))
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      let oversized = false
      res.on("data", (chunk: Buffer) => {
        if (oversized) return
        received += chunk.length
        if (received > MAX_FEED_BYTES) {
          oversized = true
          // 不传 Error：传了会 emit 未接管的 error 事件（同 images/fetch.ts 的踩坑）
          res.destroy()
          reject(new Error(`响应体超过上限（${describeBytes(MAX_FEED_BYTES)}）`))
          return
        }
        chunks.push(chunk)
      })
      res.on("end", () => {
        if (!oversized) resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on("error", reject)
    })
    req.on("error", reject)
    req.on("timeout", () => req.destroy(new Error("Request timeout")))
  })
}

/** 单条链路（代理 / 直连）的路由记忆 */
interface RouteMemo {
  /** 最近一次走通的链路 */
  prefer: "proxy" | "direct"
  at: number
}

/**
 * 「这个域名哪条链路最近走通过」的短期记忆（默认 TTL 30 分钟，可用 RSS_FETCH_ROUTE_TTL 调）。
 *
 * 为什么要记：两条链路都要试，而失败要等满超时才有结论。图片缓存是**逐张**下载的，
 * 要是每张图都先撞一次错误链路，一个源就能跑几分钟（2026-10-10 实测单个抓取 job 158.9s、
 * 队列吞吐掉到 0.4 个/分钟）。记录走通的那条之后，同一域名的后续请求直接沿用它。
 *
 * 与旧实现（只记「代理失败过的域名」）的区别：**直连失败同样要记** —— 否则
 * `RSS_FETCH_PREFER=direct` 下被墙站点每轮抓取都会先撞满一次直连超时。
 */
const ROUTE_MEMO_TTL_MS = envInt("RSS_FETCH_ROUTE_TTL", 30 * 60 * 1000)
const routeMemos = new Map<string, RouteMemo>()

function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** 该域名下一轮先试哪条链路：优先沿用它最近走通的那条，否则按 RSS_FETCH_PREFER */
function routePreference(host: string): "proxy" | "direct" {
  if (host) {
    const memo = routeMemos.get(host)
    if (memo) {
      if (Date.now() - memo.at <= ROUTE_MEMO_TTL_MS) return memo.prefer
      routeMemos.delete(host)
    }
  }
  return PREFER_DIRECT ? "direct" : "proxy"
}

/** 记下该域名这次走通的链路（供后续请求沿用） */
function rememberRoute(host: string, prefer: "proxy" | "direct"): void {
  if (host) routeMemos.set(host, { prefer, at: Date.now() })
}

/** 测试用：清空路由记忆（生产不需要调用） */
export function clearRouteMemo(): void {
  routeMemos.clear()
}

/**
 * 按「该域名的路由记忆 → 网络级失败再切另一条」的顺序取一次 URL，取数逻辑交给 request(useProxy)。
 *
 * 两条链路都要试的原因见 fetchFeed 注释；HTTP 4xx/5xx 是服务器给的答复，不换链路重试。
 * 订阅抓取（fetchFeed）与图片下载（images/fetch.ts 的 httpGet）共用这一层，
 * 所以「哪条链路能用」的记忆也是两边共享的。
 */
export async function withProxyFallback<T>(url: string, request: (useProxy: boolean) => Promise<T>): Promise<T> {
  if (!shouldProxy(url)) return request(false)

  const host = urlHost(url)
  // 走通过的那条优先；没记忆时按 RSS_FETCH_PREFER（默认代理，因为被墙站点走代理快）
  const preferred = routePreference(host)
  const first = preferred === "proxy" ? { useProxy: true, name: "代理" } : { useProxy: false, name: "直连" }
  const second = preferred === "proxy" ? { useProxy: false, name: "直连" } : { useProxy: true, name: "代理" }
  let firstError: unknown

  for (const [i, attempt] of [first, second].entries()) {
    try {
      const result = await request(attempt.useProxy)
      // 这次走通了：记住链路，下一轮直接沿用它（节点恢复/被墙变化都由下一次成功自动纠正）
      rememberRoute(host, attempt.useProxy ? "proxy" : "direct")
      return result
    } catch (err) {
      if (!isNetworkError(err)) throw err
      if (i === 0) {
        firstError = err
        continue
      }
      throw new Error(`${first.name}失败（${describeError(firstError)}）；${second.name}也失败（${describeError(err)}）`)
    }
  }
  throw firstError as Error
}

/**
 * 抓取 feed 原始文本（代理/直连切换、重定向、gzip 解压、ETag/Last-Modified 条件请求）。
 * 超时 10 秒，最多跟随 5 次重定向；服务端回 304 时 `notModified` 为 true 且不含正文。
 *
 * 为什么要回退：代理链路好坏是**按域名**的。2026-10-10 实测（Clash 节点）：
 * openai.com / wired.com / naturecanada.ca 直连 0.5-0.7s 就通、走代理直接挂死到超时；
 * 而 news.ycombinator.com / discord.com 直连必然超时、走代理 0.4-0.9s。
 * 所以两条链路都要试，先试哪条由 RSS_FETCH_PREFER 与路由记忆决定（见文件头注释）。
 *
 * 为什么要带条件请求：订阅源每 15 分钟抓一轮，绝大多数轮次内容没变。服务端支持
 * ETag/Last-Modified 时，带验证器只换回一个 304（几百字节），而不是整份 XML。
 */
export async function fetchFeed(url: string, validators?: FeedValidators): Promise<FeedFetchResult> {
  return fetchFeedWithRedirects(rewriteRssHubUrl(url), validators, 0)
}

async function fetchFeedWithRedirects(
  url: string,
  validators: FeedValidators | undefined,
  redirects: number,
): Promise<FeedFetchResult> {
  if (redirects > MAX_REDIRECTS) throw new Error("Too many redirects")

  // 条件请求头只带在「验证器来源的那个 URL」上：重定向中间跳是另一个资源，
  // 把最终资源的 ETag 发给它既无意义也可能被误判。旧版 FeedDoc 没有 url 时按第一跳处理。
  const validatorMatches = validators
    ? (validators.url !== undefined ? validators.url === url : redirects === 0)
    : false
  const headers: http.OutgoingHttpHeaders = {}
  if (validatorMatches) {
    // 优先 If-Modified-Since：部分服务端（Apache mod_deflate）会按压缩变体改写 ETag
    //（实测 codingnow 的响应是 `ETag: "...-gzip"`），把它原样带回去反而永远命中不了；
    // If-Modified-Since 与 Content-Encoding 无关。只有拿不到 Last-Modified 时才用 ETag。
    if (validators!.lastModified) headers["If-Modified-Since"] = validators!.lastModified
    else if (validators!.etag) headers["If-None-Match"] = validators!.etag
  }

  const res = await withProxyFallback(url, (useProxy) => requestOnce(url, useProxy, headers))

  if (res.status === 304) {
    return {
      notModified: true,
      etag: headerValue(res.headers.etag),
      lastModified: headerValue(res.headers["last-modified"]),
      validatorUrl: url,
    }
  }
  if (res.status >= 300 && res.status < 400) {
    const location = headerValue(res.headers.location)
    if (!location) throw new Error(`Redirect without location: ${res.status}`)
    return fetchFeedWithRedirects(new URL(location, url).href, validators, redirects + 1)
  }

  const body = await decodeContent(res.body, headerValue(res.headers["content-encoding"]))
  return {
    notModified: false,
    content: body.toString("utf-8"),
    etag: headerValue(res.headers.etag),
    lastModified: headerValue(res.headers["last-modified"]),
    validatorUrl: url,
  }
}

/**
 * 抓取并解析订阅源；带 validators 时可能直接返回 `{ notModified: true }`（服务端 304）。
 * 调用方拿到新内容后把响应头里的 etag/lastModified 存下来，下一轮再带回去即可跳过全文下载。
 */
export async function fetchParsedFeed(url: string, validators?: FeedValidators): Promise<ParsedFeedResult> {
  const fetched = await fetchFeed(url, validators)
  if (fetched.notModified) return { notModified: true }
  return {
    notModified: false,
    feed: parseFeedContent(fetched.content),
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    validatorUrl: fetched.validatorUrl,
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
