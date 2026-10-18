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
  "RSS_FETCH_PREFER", "rss_fetch_prefer",
  "RSS_FETCH_ROUTE_TTL", "rss_fetch_route_ttl",
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

  /**
   * 回退要「记住」：图片缓存是逐张下载的（还带 4 次重试），每个域名都先撞一次代理超时的话，
   * 一个源就能跑几分钟（实测单 job 158.9s）。订阅抓取与图片下载共用这一层，记忆也共享。
   */
  it("代理失败后记住该域名：同一域名第二次直连优先，别的域名不受影响", async () => {
    const parser = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890" })
    const calls: boolean[] = []
    const request = async (useProxy: boolean) => {
      calls.push(useProxy)
      if (useProxy) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
      return "ok"
    }

    expect(await parser.withProxyFallback("https://example.com/feed", request)).toBe("ok")
    expect(calls).toEqual([true, false])

    calls.length = 0
    expect(await parser.withProxyFallback("https://example.com/feed", request)).toBe("ok")
    expect(calls).toEqual([false])

    calls.length = 0
    await parser.withProxyFallback("https://other.example.org/feed", request)
    expect(calls).toEqual([true, false])
  })

  it("HTTP 状态码不换链路（4xx/5xx 换代理也一样）", async () => {
    const parser = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890" })
    const calls: boolean[] = []
    const request = async (useProxy: boolean) => {
      calls.push(useProxy)
      throw new Error("HTTP 404")
    }

    await expect(parser.withProxyFallback("https://example.com/feed", request)).rejects.toThrow("HTTP 404")
    expect(calls).toEqual([true])
  })

  it("两条链路都断时，错误里带两边的原因", async () => {
    const parser = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890" })
    const request = async (useProxy: boolean) => {
      throw Object.assign(new Error(useProxy ? "connect ETIMEDOUT" : "connect ECONNREFUSED"), {
        code: useProxy ? "ETIMEDOUT" : "ECONNREFUSED",
      })
    }

    await expect(parser.withProxyFallback("https://example.com/feed", request))
      .rejects.toThrow(/代理失败.*ETIMEDOUT.*直连也失败.*ECONNREFUSED/)
  })

  it("未配代理时只走一次直连", async () => {
    const parser = await load({})
    const calls: boolean[] = []

    await parser.withProxyFallback("https://example.com/feed", async (useProxy: boolean) => {
      calls.push(useProxy)
      return "ok"
    })
    expect(calls).toEqual([false])
  })
})

/**
 * 默认全程走代理 = 每个能直连的源都在烧代理流量。RSS_FETCH_PREFER=direct 让「能直连的
 * 先直连」，被墙域名在第一次网络级失败后由路由记忆自动改走代理（见 parser.ts 文件头）。
 */
describe("RSS_FETCH_PREFER=direct：能直连的不烧代理", () => {
  it("先直连；直连网络失败回退代理，并记住代理", async () => {
    const parser = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890", RSS_FETCH_PREFER: "direct" })
    const calls: boolean[] = []
    const request = async (useProxy: boolean) => {
      calls.push(useProxy)
      if (!useProxy) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
      return "ok"
    }

    expect(await parser.withProxyFallback("https://blocked.example.com/feed", request)).toBe("ok")
    expect(calls).toEqual([false, true])

    // 第二次沿用「最近走通过」的代理，不再先撞一次直连超时
    calls.length = 0
    expect(await parser.withProxyFallback("https://blocked.example.com/feed", request)).toBe("ok")
    expect(calls).toEqual([true])
  })

  it("直连成功时记住直连，后续不再尝试代理", async () => {
    const parser = await load({ RSS_FETCH_PROXY: "http://127.0.0.1:7890", RSS_FETCH_PREFER: "direct" })
    const calls: boolean[] = []
    const request = async (useProxy: boolean) => {
      calls.push(useProxy)
      return "ok"
    }

    await parser.withProxyFallback("https://direct.example.com/feed", request)
    await parser.withProxyFallback("https://direct.example.com/feed", request)
    expect(calls).toEqual([false, false])
  })
})

/** 订阅源是文本：不带 Accept-Encoding 会一直拿未压缩全文；带验证器则内容没变时只回 304。 */
describe("条件请求与响应压缩", () => {
  const servers: import("node:http").Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  /** 起一个自定义行为的本地 HTTP 服务，返回 feed 地址 */
  async function serve(handler: import("node:http").RequestListener): Promise<string> {
    const http = await import("node:http")
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as import("node:net").AddressInfo).port
    return `http://127.0.0.1:${port}/feed`
  }

  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>本地源</title><item><title>条目一</title><guid>g1</guid></item></channel></rss>`

  it("请求带 Accept-Encoding，gzip 响应能正确解压", async () => {
    const zlib = await import("node:zlib")
    let acceptEncoding = ""
    const url = await serve((req, res) => {
      acceptEncoding = String(req.headers["accept-encoding"] ?? "")
      res.writeHead(200, { "Content-Type": "application/rss+xml", "Content-Encoding": "gzip" })
      res.end(zlib.gzipSync(Buffer.from(RSS)))
    })

    const parser = await load({})
    const feed = await parser.parseFeedUrl(url)

    expect(acceptEncoding).toContain("gzip")
    expect(feed.title).toBe("本地源")
    expect(feed.items[0]?.title).toBe("条目一")
  })

  it("带 ETag 条件请求命中 304 时返回 notModified，不再返回正文", async () => {
    const url = await serve((req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { ETag: '"v1"' })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "application/rss+xml", ETag: '"v1"' })
      res.end(RSS)
    })

    const parser = await load({})
    const first = await parser.fetchParsedFeed(url)
    if (first.notModified) throw new Error("首次抓取不应该拿到 304")
    expect(first.feed.title).toBe("本地源")
    expect(first.etag).toBe('"v1"')

    const second = await parser.fetchParsedFeed(url, { etag: first.etag })
    expect(second.notModified).toBe(true)
  })
})
