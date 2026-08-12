import { describe, it, expect } from "vitest"
import http from "node:http"
import sharp from "sharp"
import { extractImageUrls, compressToAvif, cacheSingleImage } from "../rss/entry-images"

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
