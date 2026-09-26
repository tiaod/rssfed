import { describe, it, expect } from "vitest"
import http from "node:http"
import sharp from "sharp"
import { extractImageUrls, compressToAvif, cacheSingleImage, cacheEntryImages, FEED_ICON_CACHE_VERSION } from "../rss/entry-images"

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

  it("大尺寸源图也会被压到 64px（侧边栏只显示约 20px 头像）", async () => {
    // 图标若继承正文图片的 1200px 上限，浏览器解码几百张会阻塞主线程数秒：
    // 实测 300 张 1200px AVIF 解码阻塞 1.0–5.3s，而 64px 只要 0–15ms。
    const png = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 200, g: 120, b: 40 } },
    }).png().toBuffer()

    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "image/png")
      res.end(png)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/big-icon.png`

    const out = await cacheSingleImage(url)
    server.close()

    expect(out).not.toBeNull()
    expect(out!.image.width).toBe(64)
    // 参数版本要写进元数据，否则老文档不会因参数变化而重新压缩
    expect(out!.image.v).toBe(FEED_ICON_CACHE_VERSION)
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

describe("cacheEntryImages per-feed 配置", () => {
  // 生成 n 张可缓存的小图，用于验证 cacheAll（不限张数与体积）与预算/硬顶行为
  async function serveImages(count: number, prefix: string) {
    const bufs = await Promise.all(
      Array.from({ length: count }, () => sharp({
        create: { width: 300, height: 220, channels: 3, background: { r: 40, g: 80, b: 120 } },
      }).png().toBuffer()),
    )
    let hits = 0
    const server = http.createServer((req, res) => {
      hits++
      res.setHeader("Content-Type", "image/png")
      const idx = Number((req.url ?? "").match(/\d+/)?.[0] ?? 0)
      res.end(bufs[idx] ?? bufs[0])
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    return {
      port,
      bufs,
      content: Array.from({ length: count }, (_, i) =>
        `<img src="http://127.0.0.1:${port}/${prefix}${i}.png">`).join(""),
      close: () => server.close(),
    }
  }

  it("cacheAll 开启时缓存正文全部图片（不受预算与张数硬顶约束）", async () => {
    const total = 7
    const { port, content, close } = await serveImages(total, "a")
    try {
      const { images } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`, undefined, { cacheAll: true })
      expect(images.length).toBe(total) // 全部被缓存，未被预算/硬顶截断
    } finally {
      close()
    }
  })

  it("maxImageCount 覆盖全局默认", async () => {
    const { port, content, close } = await serveImages(4, "b")
    try {
      const { images } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`, undefined, { maxImageCount: 2 })
      expect(images.length).toBe(2)
    } finally {
      close()
    }
  })

  it("不传配置时走全局默认：体积预算 1MB 下少量小图全部缓存（不再卡在 5 张）", async () => {
    const { port, content, close } = await serveImages(7, "c")
    try {
      const { images, stats } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`)
      expect(images.length).toBe(7) // 7 张小图远小于 1MB 预算
      expect(stats.skippedByBudget).toBe(0)
    } finally {
      close()
    }
  })

  it("预算生效：累计附件体积超上限后停止缓存后续图片", async () => {
    const { port, content, close, bufs } = await serveImages(6, "d")
    try {
      const single = (await compressToAvif(bufs[0]!))!.buffer.length
      // 预算够 2 张、不够 3 张（+16 字节余量避免边界抖动）
      const { images, stats } = await cacheEntryImages(
        content, `http://127.0.0.1:${port}/post`, undefined,
        { maxEntryImageBytes: single * 2 + 16 },
      )
      expect(images.length).toBe(2)
      expect(stats.cached).toBe(2)
      expect(stats.skippedByBudget).toBe(4) // 6 张候选，缓存 2 张，预算跳过 4 张
      expect(stats.failed).toBe(0) // 预算跳过不算失败
    } finally {
      close()
    }
  })

  it("首图必留：预算小于单张体积时仍缓存第一张", async () => {
    const { port, content, close } = await serveImages(4, "e")
    try {
      const { images, stats } = await cacheEntryImages(
        content, `http://127.0.0.1:${port}/post`, undefined,
        { maxEntryImageBytes: 1 },
      )
      expect(images.length).toBe(1)
      expect(stats.skippedByBudget).toBe(3)
    } finally {
      close()
    }
  })

  it("协议封面自身超预算也保留（否则整篇没图），并占用预算", async () => {
    const { port, content, close } = await serveImages(4, "f")
    try {
      const cover = `http://127.0.0.1:${port}/f0.png`
      const { images, stats } = await cacheEntryImages(
        content, `http://127.0.0.1:${port}/post`, cover,
        { maxEntryImageBytes: 1 }, // 预算小到只够封面
      )
      expect(images).toHaveLength(1)
      expect(images[0]!.url).toBe(cover)
      expect(images[0]!.cover).toBe(true)
      expect(stats.skippedByBudget).toBe(3)
    } finally {
      close()
    }
  })

  it("协议封面占用预算后，正文图按剩余预算继续填充", async () => {
    const { port, content, close, bufs } = await serveImages(4, "g")
    try {
      const single = (await compressToAvif(bufs[0]!))!.buffer.length
      const cover = `http://127.0.0.1:${port}/g0.png`
      const { images, stats } = await cacheEntryImages(
        content, `http://127.0.0.1:${port}/post`, cover,
        { maxEntryImageBytes: single * 2 + 16 }, // 封面 + 1 张正文图
      )
      expect(images).toHaveLength(2)
      expect(images[0]!.url).toBe(cover) // 封面排第一
      expect(images[1]!.url).toContain("/g1.png") // 正文里 g0 重复被跳过，下一张是 g1
      expect(stats.skippedByBudget).toBe(2)
    } finally {
      close()
    }
  })
})

describe("cacheEntryImages Content-Type 兜底与失败统计", () => {
  /** 起一个本地图床，handler 自定义响应头与状态码 */
  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler)
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    return { port, close: () => server.close() }
  }

  async function png(w = 300, h = 200) {
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 6, b: 7 } } }).png().toBuffer()
  }

  it("Content-Type 为 application/octet-stream 但 URL 是图片扩展名时仍缓存（storage.googleapis.com 场景）", async () => {
    const buf = await png()
    const { port, close } = await serve((_req, res) => {
      res.setHeader("Content-Type", "application/octet-stream")
      res.end(buf)
    })
    try {
      const { images, stats } = await cacheEntryImages(
        `<img src="http://127.0.0.1:${port}/a.png">`,
        `http://127.0.0.1:${port}/`,
      )
      expect(images).toHaveLength(1)
      expect(stats.cached).toBe(1)
      expect(stats.failed).toBe(0)
    } finally {
      close()
    }
  })

  it("Content-Type 为 text/html（防盗链错误页）时拒绝，并记为 content-type 失败", async () => {
    const { port, close } = await serve((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end("<html><body>403 Forbidden</body></html>")
    })
    try {
      const { images, stats } = await cacheEntryImages(
        `<img src="http://127.0.0.1:${port}/a.png">`,
        `http://127.0.0.1:${port}/`,
      )
      expect(images).toHaveLength(0)
      expect(stats.failed).toBe(1)
      expect(stats.reasons["content-type"]).toBe(1)
    } finally {
      close()
    }
  })

  it("octet-stream 且 URL 无图片扩展名时仍拒绝（避免把代理接口的二进制误当图片）", async () => {
    const buf = await png()
    const { port, close } = await serve((_req, res) => {
      res.setHeader("Content-Type", "application/octet-stream")
      res.end(buf)
    })
    try {
      const { images, stats } = await cacheEntryImages(
        `<img src="http://127.0.0.1:${port}/img-proxy?id=1">`,
        `http://127.0.0.1:${port}/`,
      )
      expect(images).toHaveLength(0)
      expect(stats.reasons["content-type"]).toBe(1)
    } finally {
      close()
    }
  })

  it("统计失败原因：HTTP 404 → http-status，源图超限 → too-large", async () => {
    const buf = await png()
    const { port, close } = await serve((req, res) => {
      if (req.url === "/missing.png") {
        res.statusCode = 404
        res.setHeader("Content-Type", "text/plain")
        res.end("not found")
        return
      }
      res.setHeader("Content-Type", "image/png")
      res.end(buf)
    })
    try {
      // 极小上限：PNG 头就超过，触发流式截断
      const { stats } = await cacheEntryImages(
        `<img src="http://127.0.0.1:${port}/missing.png"><img src="http://127.0.0.1:${port}/big.png">`,
        `http://127.0.0.1:${port}/`,
        undefined,
        { maxSourceImageBytes: 10 },
      )
      expect(stats.reasons["http-status"]).toBe(1)
      expect(stats.reasons["too-large"]).toBe(1)
      expect(stats.failed).toBe(2)
    } finally {
      close()
    }
  })

  it("统计因数量上限跳过的张数（与下载失败区分开）", async () => {
    const buf = await png()
    const { port, close } = await serve((_req, res) => {
      res.setHeader("Content-Type", "image/png")
      res.end(buf)
    })
    try {
      const content = Array.from({ length: 7 }, (_, i) =>
        `<img src="http://127.0.0.1:${port}/p${i}.png">`).join("")
      const { stats } = await cacheEntryImages(content, `http://127.0.0.1:${port}/post`, undefined, { maxImageCount: 2 })
      expect(stats.candidates).toBe(2)
      expect(stats.skippedByLimit).toBe(5) // 7 张候选，上限 2，跳过 5 张
      expect(stats.failed).toBe(0) // 跳过不算失败
    } finally {
      close()
    }
  })

  it("统计附件字节与成功张数", async () => {
    const buf = await png()
    const { port, close } = await serve((_req, res) => {
      res.setHeader("Content-Type", "image/png")
      res.end(buf)
    })
    try {
      const { attachments, images, stats } = await cacheEntryImages(
        `<img src="http://127.0.0.1:${port}/a.png">`,
        `http://127.0.0.1:${port}/`,
      )
      expect(stats.cached).toBe(images.length)
      expect(stats.bytes).toBeGreaterThan(0)
      expect(stats.bytes).toBe(attachments.reduce((a, x) => a + x.data.length, 0))
    } finally {
      close()
    }
  })
})
