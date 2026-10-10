import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * 抓取代理只认 RSS_FETCH_PROXY，**不能**认 HTTP_PROXY / HTTPS_PROXY。
 *
 * 后者是进程级惯例变量，axios（nano → CouchDB）、AWS SDK、undici 等库都会自动读取：
 * 一旦后端进程里设了 HTTP_PROXY，CouchDB / S3 / ActivityPub 的请求也会被塞进代理，
 * 而且现象很隐蔽（本地请求超时/412 之类），所以这里把它钉成回归测试。
 */

const ENV_KEYS = [
  "RSS_FETCH_PROXY", "rss_fetch_proxy",
  "RSS_FETCH_NO_PROXY", "rss_fetch_no_proxy",
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
  "NO_PROXY", "no_proxy",
] as const

/** 清空所有代理相关变量，避免受运行环境（CI/本机）影响 */
function clearProxyEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

/** 设置指定变量后重新加载 parser（模块级常量在顶层求值，需重置模块注册表） */
async function load(env: Partial<Record<typeof ENV_KEYS[number], string>>) {
  vi.resetModules()
  clearProxyEnv()
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  return await import("../rss/parser")
}

afterEach(clearProxyEnv)

describe("抓取代理环境变量", () => {
  it("配 RSS_FETCH_PROXY 时：agent 生效，非本机地址走代理", async () => {
    const { shouldProxy, httpAgent, httpsAgent } = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890" })

    expect(httpAgent).toBeDefined()
    expect(httpsAgent).toBeDefined()
    expect(shouldProxy("https://news.ycombinator.com/rss")).toBe(true)
  })

  it("只配 HTTP_PROXY / HTTPS_PROXY 时：不生效，也不会把 CouchDB 等请求塞进代理", async () => {
    const { shouldProxy, httpAgent, httpsAgent } = await load({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "",
    })

    expect(httpAgent).toBeUndefined()
    expect(httpsAgent).toBeUndefined()
    expect(shouldProxy("https://news.ycombinator.com/rss")).toBe(false)
    expect(shouldProxy("http://localhost:5984/rssfed")).toBe(false)
  })

  it("默认绕过本机：本地 RSSHub 不会被丢给代理", async () => {
    const { shouldProxy } = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890" })

    expect(shouldProxy("http://localhost:1200/acfun/article/110")).toBe(false)
    expect(shouldProxy("http://127.0.0.1:1200/feed")).toBe(false)
    expect(shouldProxy("http://[::1]:1200/feed")).toBe(false)
    expect(shouldProxy("https://example.com/feed")).toBe(true)
  })

  it("RSS_FETCH_NO_PROXY 可覆盖默认值（空前缀/子域写法都支持）", async () => {
    const { shouldProxy } = await load({
      RSS_FETCH_PROXY: "http://127.0.0.1:7890",
      RSS_FETCH_NO_PROXY: ".internal,example.com",
    })

    expect(shouldProxy("http://wiki.internal/feed")).toBe(false)
    expect(shouldProxy("https://example.com/feed")).toBe(false)
    expect(shouldProxy("https://elsewhere.com/feed")).toBe(true)
  })

  it("未配置代理时 shouldProxy 恒为 false", async () => {
    const { shouldProxy, httpAgent, httpsAgent } = await load({})

    expect(httpAgent).toBeUndefined()
    expect(httpsAgent).toBeUndefined()
    expect(shouldProxy("https://news.ycombinator.com/rss")).toBe(false)
  })
})

/**
 * 代理链路好坏是按域名的：2026-10-10 实测 Clash 节点下 openai.com / wired.com /
 * naturecanada.ca 直连 0.5-0.7s 就通、走代理直接挂死；而 news.ycombinator.com /
 * discord.com 必须走代理。所以代理第一次网络级失败后要回退直连，否则一刀切代理会把
 * 原本正常的源弄挂。
 */
describe("代理失败回退直连", () => {
  const servers: import("node:http").Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  /** 起一个本地 RSS 服务，返回它的地址 */
  async function serveRss(): Promise<string> {
    const http = await import("node:http")
    const server = http.createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "application/rss+xml" })
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>本地源</title><item><title>条目一</title><guid>g1</guid></item></channel></rss>`)
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as import("node:net").AddressInfo).port
    return `http://127.0.0.1:${port}/feed`
  }

  it("代理连不上时回退直连，抓取仍然成功", async () => {
    const url = await serveRss()
    // 死代理（端口 1 必然 ECONNREFUSED）+ 让本机也走代理（默认是绕过本机）
    const parser = await load({
      RSS_FETCH_PROXY: "http://127.0.0.1:1",
      RSS_FETCH_NO_PROXY: "notlocalhost",
    })
    expect(parser.shouldProxy(url)).toBe(true)

    const feed = await parser.parseFeedUrl(url)
    expect(feed.title).toBe("本地源")
    expect(feed.items[0]?.title).toBe("条目一")
  })

  it("没有代理时不回退（直连失败就是失败）", async () => {
    const parser = await load({})
    await expect(parser.parseFeedUrl("http://127.0.0.1:1/feed")).rejects.toThrow()
  })

  it("isNetworkError 只认网络级失败，HTTP 状态码不触发回退", async () => {
    const { isNetworkError } = await load({})

    expect(isNetworkError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(true)
    expect(isNetworkError(new Error("Request timeout"))).toBe(true)
    expect(isNetworkError(new AggregateError([Object.assign(new Error("x"), { code: "ENETUNREACH" })]))).toBe(true)
    expect(isNetworkError(new Error("HTTP 404"))).toBe(false)
    expect(isNetworkError(new Error("HTTP 403"))).toBe(false)
    expect(isNetworkError(new Error("Unsupported feed format: html"))).toBe(false)
  })
})
