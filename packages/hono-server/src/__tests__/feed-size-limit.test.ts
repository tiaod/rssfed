import { afterAll, beforeAll, describe, expect, it } from "vitest"
import http from "node:http"
import zlib from "node:zlib"

/**
 * feed 响应体大小上限（见 `rss/parser.ts` 的 MAX_FEED_BYTES / MAX_FEED_DECODED_BYTES）。
 *
 * 这两个上限在模块 import 时读环境变量，所以必须先设 env、再动态 import；
 * 用本地 HTTP server 造「超大响应」与「gzip 压缩炸弹」，不依赖外网。
 */
process.env.MAX_FEED_BYTES = "1024"
process.env.MAX_FEED_DECODED_BYTES = "4096"

let server: http.Server
let base: string

const SMALL_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>hello</title><guid>g1</guid><link>https://example.test/1</link></item></channel></rss>`

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/plain-large") {
      // 不带 Content-Encoding，也没有 Content-Length：走流式累计上限
      res.writeHead(200, { "Content-Type": "application/rss+xml" })
      res.end("x".repeat(2048))
      return
    }
    if (req.url === "/declared-large") {
      const body = "x".repeat(2048)
      res.writeHead(200, { "Content-Type": "application/rss+xml", "Content-Length": String(body.length) })
      res.end(body)
      return
    }
    if (req.url === "/gzip-bomb") {
      // 压缩态只有几十字节，解压后 64KB：只有解压后上限能挡住
      const body = zlib.gzipSync(Buffer.alloc(64 * 1024))
      res.writeHead(200, { "Content-Type": "application/rss+xml", "Content-Encoding": "gzip" })
      res.end(body)
      return
    }
    if (req.url === "/ok") {
      const body = zlib.gzipSync(Buffer.from(SMALL_RSS))
      res.writeHead(200, { "Content-Type": "application/rss+xml", "Content-Encoding": "gzip" })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("无法获取测试端口")
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const { fetchParsedFeed } = await import("../rss/parser")

describe("feed 响应体大小上限", () => {
  it("压缩态超过 MAX_FEED_BYTES：流式累计到上限即拒绝", async () => {
    await expect(fetchParsedFeed(`${base}/plain-large`)).rejects.toThrow(/响应体超过上限/)
  })

  it("有 Content-Length 时零成本提前拒绝", async () => {
    await expect(fetchParsedFeed(`${base}/declared-large`)).rejects.toThrow(/响应体超过上限/)
  })

  it("gzip 压缩炸弹：解压后超过 MAX_FEED_DECODED_BYTES 即拒绝（压缩态本身很小）", async () => {
    await expect(fetchParsedFeed(`${base}/gzip-bomb`)).rejects.toThrow(/解压后响应体超过上限/)
  })

  it("限额内的正常响应不受影响（含 gzip 解压）", async () => {
    const result = await fetchParsedFeed(`${base}/ok`)
    expect(result.notModified).toBe(false)
    if (result.notModified) return
    expect(result.feed.title).toBe("t")
    expect(result.feed.items[0]?.guid).toBe("g1")
  })
})
