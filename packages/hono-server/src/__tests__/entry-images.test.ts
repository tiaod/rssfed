import { describe, it, expect } from "vitest"
import http from "node:http"
import sharp from "sharp"
import { extractImageUrls, compressToAvif, cacheSingleImage, cacheEntryImages } from "../rss/entry-images"

describe("extractImageUrls", () => {
  const html = [
    '<p>正文</p>',
    '<img src="/cover.png" alt="封面">',
    '<img src="https://cdn.example.com/a.jpg">',
    '<img src=\'https://cdn.example.com/b.webp\' />',
    '<img src="data:image/png;base64,iVBORw0KGgo=">',
    '<img src="img/rel.png">',
  ].join("")

  it("提取 <img src> 并解析为绝对地址", () => {
    const urls = extractImageUrls(html, "https://blog.example.com/posts/1")
    expect(urls).toEqual([
      "https://blog.example.com/cover.png",
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.webp",
      "https://blog.example.com/posts/img/rel.png",
    ])
  })

  it("过滤 data: URI 与非法协议", () => {
    const urls = extractImageUrls(
      '<img src="data:image/png;base64,xxx"><img src="ftp://x.com/a.png"><img src="javascript:void(0)">',
      "https://x.com/",
    )
    expect(urls).toEqual([])
  })

  it("去重", () => {
    const urls = extractImageUrls(
      '<img src="https://x.com/a.png"><img src="https://x.com/a.png">',
      "https://x.com/",
    )
    expect(urls).toEqual(["https://x.com/a.png"])
  })

  it("解码 HTML 实体（&amp; 等）后再提取，与前端 DOMParser 解码结果一致", () => {
    const urls = extractImageUrls(
      '<img src="https://x.com/img-proxy/?k=abc&amp;u=https%3A%2F%2Fcdn.x.com%2Fa.png">',
      "https://x.com/post/1",
    )
    expect(urls).toEqual(["https://x.com/img-proxy/?k=abc&u=https%3A%2F%2Fcdn.x.com%2Fa.png"])
  })

  it("按 limit 截断", () => {
    const html = [1, 2, 3, 4].map(i => `<img src="https://x.com/${i}.png">`).join("")
    expect(extractImageUrls(html, "https://x.com/", 2)).toHaveLength(2)
  })

  it("空内容返回空数组", () => {
    expect(extractImageUrls(undefined, "https://x.com/")).toEqual([])
    expect(extractImageUrls("", "https://x.com/")).toEqual([])
  })
})

describe("compressToAvif", () => {
  it("将 PNG 压缩为 AVIF 且体积更小", async () => {
    // 生成一张 400x300 的渐变测试图（纯色会被 AVIF 压到极小，但仍是有效 AVIF）
    const source = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 180, g: 90, b: 40 },
      },
    }).png().toBuffer()

    const out = await compressToAvif(source)
    expect(out).not.toBeNull()
    // AVIF 文件头：第 4-11 字节为 "ftypavif"
    expect(out!.buffer.subarray(4, 12).toString("ascii")).toBe("ftypavif")
    expect(out!.buffer.length).toBeLessThan(source.length)
    expect(out!.width).toBe(400)
    expect(out!.height).toBe(300)
  })

  it("非法输入返回 null", async () => {
    expect(await compressToAvif(Buffer.from("not an image"))).toBeNull()
  })
})

describe("cacheSingleImage", () => {
  it("下载压缩为 AVIF 且并发相同 URL 只请求一次", async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer()

    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.setHeader("Content-Type", "image/png")
      res.end(png)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/icon.png`

    const [a, b] = await Promise.all([cacheSingleImage(url), cacheSingleImage(url)])
    server.close()

    expect(hits).toBe(1) // 去重：同 URL 只下载一次
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.image.url).toBe(url)
    expect(a!.image.attachment).toBe("feed-image.avif")
    expect(a!.data.subarray(4, 12).toString("ascii")).toBe("ftypavif")
  })
})

describe("cacheEntryImages 封面选择", () => {
  it("无协议封面时选正文第一张合格图（过滤小图）", async () => {
    // 三张图：小图标(100x100) / 中图(400x300) / 大图(800x600)
    const mk = (w: number, h: number) => sharp({
      create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer()
    const [small, mid, big] = await Promise.all([mk(100, 100), mk(400, 300), mk(800, 600)])

    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "image/png")
      if (req.url === "/small.png") res.end(small)
      else if (req.url === "/mid.png") res.end(mid)
      else res.end(big)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    // 顺序：小图 → 大图 → 中图；应选第一张合格（大图在首位时选它）
    const content = `<img src="http://127.0.0.1:${port}/big.png"><img src="http://127.0.0.1:${port}/small.png"><img src="http://127.0.0.1:${port}/mid.png">`

    const { images } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`)
    server.close()

    const covers = images.filter((i) => i.cover)
    expect(covers).toHaveLength(1)
    expect(covers[0]!.url).toContain("/big.png") // 第一张合格图被选中
  })

  it("协议封面优先于正文图片", async () => {
    const mk = (w: number, h: number) => sharp({
      create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer()
    const [body, protocol] = await Promise.all([mk(800, 600), mk(300, 200)])

    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "image/png")
      if (req.url === "/protocol.png") res.end(protocol)
      else res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    // 正文有一张 800x600 的大图，但协议封面（media:thumbnail）应优先作为封面
    const content = `<img src="http://127.0.0.1:${port}/body.png">`
    const protocolUrl = `http://127.0.0.1:${port}/protocol.png`

    const { images } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`, protocolUrl)
    server.close()

    const covers = images.filter((i) => i.cover)
    expect(covers).toHaveLength(1)
    expect(covers[0]!.url).toContain("/protocol.png")
    expect(images[0]!.cover).toBe(true) // 协议封面排在第一位
    expect(images).toHaveLength(2) // 正文图仍被缓存
  })

  it("全部是小图时不标记封面", async () => {
    const tiny = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer()
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "image/png")
      res.end(tiny)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    const { images } = await cacheEntryImages(`<img src="http://127.0.0.1:${port}/a.png">`, `http://127.0.0.1:${port}/`)
    server.close()
    expect(images.every((i) => !i.cover)).toBe(true)
  })
})
