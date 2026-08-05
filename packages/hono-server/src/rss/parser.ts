import Parser from "rss-parser"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"

// 代理配置来自环境变量（与 curl/node 惯例一致），兼容大小写两种写法
const PROXY_HTTP = process.env.HTTP_PROXY || process.env.http_proxy
const PROXY_HTTPS = process.env.HTTPS_PROXY || process.env.https_proxy
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)

// 连接级代理可复用，创建一次即可（内部有连接池）
const httpAgent = PROXY_HTTP ? new HttpProxyAgent(PROXY_HTTP) : undefined
const httpsAgent = PROXY_HTTPS ? new HttpsProxyAgent(PROXY_HTTPS) : undefined

/** 按 NO_PROXY 规则判断该 URL 是否应走代理（支持 *.example.com / .example.com / host 写法） */
function shouldProxy(url: string): boolean {
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

/**
 * 支持代理的 Parser：每次请求（含重定向）按当前 URL 独立决定是否走代理，
 * 不修改共享的 options.requestOptions，避免并发请求之间互相污染。
 */
class ProxyAwareParser extends Parser {
  /** rss-parser 构造时把 options 挂到实例上，但其类型声明未暴露该字段 */
  declare options: Parser.ParserOptions<any, any>

  parseURL(feedUrl: string, callback?: (err: Error, feed: any) => void, redirectCount = 0) {
    const agent = shouldProxy(feedUrl)
      ? (feedUrl.startsWith("https") ? httpsAgent : httpAgent)
      : undefined
    // parseURL 在同步阶段读取 this.options，此处整体替换成新对象即可安全生效
    this.options = { ...this.options, requestOptions: { ...this.options.requestOptions, agent } }
    return super.parseURL(feedUrl, callback as any, redirectCount)
  }
}

export const rssParser = new ProxyAwareParser({
  timeout: 10000,
  headers: {
    "User-Agent": "RSSFed/0.1.0",
  },
})

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