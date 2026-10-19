import { describe, expect, it, vi } from "vitest"
import {
  getCompressedImage,
  imageCacheKey,
  isFetchableImageUrl,
  normalizeImageRequest,
  IMAGE_CACHE_VERSION,
} from "../images/cache"
import { DEFAULT_AVIF_QUALITY, DEFAULT_MAX_IMAGE_WIDTH } from "../images/fetch"
import type { Storage } from "../storage"

/** 内存 Storage：图片缓存单测不该碰 S3/磁盘 */
function memoryStorage(): Storage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  return {
    files,
    write: async (content: Buffer, key: string) => {
      files.set(key, content)
      return key
    },
    read: async (key: string) => {
      const hit = files.get(key)
      if (!hit) throw new Error("not_found")
      return hit
    },
    readWithMeta: async (key: string) => {
      const hit = files.get(key)
      if (!hit) throw new Error("not_found")
      return { content: hit, contentType: "image/avif" }
    },
    delete: async (key: string) => {
      files.delete(key)
    },
    exists: async (key: string) => files.has(key),
    async *listBatches(prefix: string) {
      const rows = [...files.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, content]) => ({ key, lastModified: new Date(0), size: content.length }))
      for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000)
    },
    getPublicUrl: () => undefined,
  }
}

const AVIF_STUB = Buffer.from("avif-bytes")
const IMAGE_SIZE = { width: 800, height: 600 }
const BLURHASH = "L43yGppefQpepyflfQflfQfQfQfQ"

/** 假的下载/压缩：记录调用次数，返回固定字节 */
function fakeCodec() {
  const calls = { download: 0, compress: 0 }
  return {
    calls,
    download: async (_url: string, _maxBytes?: number) => {
      calls.download++
      return { buffer: Buffer.from("source-bytes") }
    },
    compress: async (_buffer: Buffer, _opts?: { maxWidth?: number, quality?: number }) => {
      calls.compress++
      return { buffer: AVIF_STUB, width: IMAGE_SIZE.width, height: IMAGE_SIZE.height }
    },
  }
}

/** 假的尺寸探测 / blurhash：记录调用次数（命中路径靠它们从 AVIF 现算） */
function fakeMeta() {
  const calls = { size: 0, blurhash: 0 }
  return {
    calls,
    size: async (_buffer: Buffer) => {
      calls.size++
      return IMAGE_SIZE
    },
    blurhash: async (_buffer: Buffer) => {
      calls.blurhash++
      return BLURHASH
    },
  }
}

describe("imageCacheKey", () => {
  it("缺省参数与显式默认值算出同一个 key（必须先补齐再哈希）", () => {
    const a = imageCacheKey({ url: "https://x.test/a.png" })
    const b = imageCacheKey({ url: "https://x.test/a.png", maxWidth: DEFAULT_MAX_IMAGE_WIDTH, quality: DEFAULT_AVIF_QUALITY })
    expect(a).toBe(b)
    expect(a).toBe(`image-cache/v${IMAGE_CACHE_VERSION}/${a.split("/").pop()}`)
  })

  it("宽度/质量不同则 key 不同，URL 不同也 key 不同", () => {
    const base = { url: "https://x.test/a.png" }
    expect(imageCacheKey(base)).not.toBe(imageCacheKey({ ...base, maxWidth: 400 }))
    expect(imageCacheKey(base)).not.toBe(imageCacheKey({ ...base, quality: 80 }))
    expect(imageCacheKey(base)).not.toBe(imageCacheKey({ url: "https://x.test/b.png" }))
  })

  it("maxSourceBytes 不进 key：它只决定下不下得动，不影响输出字节", () => {
    const base = { url: "https://x.test/a.png" }
    expect(imageCacheKey(base)).toBe(imageCacheKey({ ...base, maxSourceBytes: 1024 }))
  })
})

describe("normalizeImageRequest", () => {
  it("缺省字段补齐为全局默认", () => {
    expect(normalizeImageRequest({ url: "u" })).toEqual({
      url: "u",
      maxWidth: DEFAULT_MAX_IMAGE_WIDTH,
      quality: DEFAULT_AVIF_QUALITY,
      maxSourceBytes: expect.any(Number),
    })
  })
})

describe("isFetchableImageUrl", () => {
  it("只放行 http(s)", () => {
    expect(isFetchableImageUrl("https://x.test/a.png")).toBe(true)
    expect(isFetchableImageUrl("http://x.test/a.png")).toBe(true)
    expect(isFetchableImageUrl("file:///etc/passwd")).toBe(false)
    expect(isFetchableImageUrl("data:image/png;base64,AAAA")).toBe(false)
    expect(isFetchableImageUrl("not a url")).toBe(false)
  })
})

describe("getCompressedImage", () => {
  it("未命中：下载 + 压缩 + 只落盘 AVIF 本体，返回 hit=false 与尺寸/blurhash", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const meta = fakeMeta()
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, ...codec, ...meta },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hit).toBe(false)
    expect(result.width).toBe(IMAGE_SIZE.width)
    expect(result.height).toBe(IMAGE_SIZE.height)
    expect(result.blurhash).toBe(BLURHASH)
    expect(result.buffer).toEqual(AVIF_STUB)
    expect(storage.files.has(result.key)).toBe(true)
    // 只有 AVIF 本体：不再写 sidecar 元数据对象
    expect([...storage.files.keys()]).toEqual([result.key])
    expect(codec.calls).toEqual({ download: 1, compress: 1 })
    expect(meta.calls).toEqual({ size: 0, blurhash: 1 })
  })

  it("第二次取同一 URL + 参数：命中缓存，不再下载/压缩，尺寸与 blurhash 从本体现算", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const meta = fakeMeta()
    const deps = { storage, ...codec, ...meta }
    const first = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)
    const second = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.hit).toBe(true)
    expect(second.key).toBe(first.key)
    expect(second.width).toBe(IMAGE_SIZE.width)
    expect(second.height).toBe(IMAGE_SIZE.height)
    expect(second.blurhash).toBe(BLURHASH)
    expect(codec.calls).toEqual({ download: 1, compress: 1 })
    // 未命中一次 blurhash，命中路径再各算一次
    expect(meta.calls).toEqual({ size: 1, blurhash: 2 })
  })

  it("并发同一 URL：合并成一次下载", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const deps = { storage, ...codec, ...fakeMeta() }
    await Promise.all([
      getCompressedImage({ url: "https://cdn.test/same.png" }, deps),
      getCompressedImage({ url: "https://cdn.test/same.png" }, deps),
      getCompressedImage({ url: "https://cdn.test/same.png" }, deps),
    ])
    expect(codec.calls.download).toBe(1)
  })

  it("下载失败按原因返回，不抛错、不写缓存", async () => {
    const storage = memoryStorage()
    const result = await getCompressedImage(
      { url: "https://cdn.test/gone.png" },
      {
        storage,
        download: async () => ({ buffer: null, reason: "http-status" as const }),
        compress: fakeCodec().compress,
      },
    )
    expect(result).toEqual({ ok: false, reason: "http-status" })
    expect(storage.files.size).toBe(0)
  })

  it("解码失败记为 decode", async () => {
    const result = await getCompressedImage(
      { url: "https://cdn.test/broken.png" },
      { storage: memoryStorage(), download: fakeCodec().download, compress: async () => null },
    )
    expect(result).toEqual({ ok: false, reason: "decode" })
  })

  it("非 http(s) 地址直接拒绝，不发请求", async () => {
    const codec = fakeCodec()
    const result = await getCompressedImage(
      { url: "file:///etc/passwd" },
      { storage: memoryStorage(), ...codec, ...fakeMeta() },
    )
    expect(result).toEqual({ ok: false, reason: "invalid-url" })
    expect(codec.calls.download).toBe(0)
  })

  it("Storage 写失败只降级为「没缓存」，仍返回压缩结果", async () => {
    const storage = memoryStorage()
    storage.write = async () => {
      throw new Error("s3 down")
    }
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, ...fakeCodec(), ...fakeMeta() },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.buffer).toEqual(AVIF_STUB)
  })

  it("命中但尺寸/blurhash 算不出来时降级为 0 / undefined，不影响取图", async () => {
    const storage = memoryStorage()
    const key = imageCacheKey({ url: "https://cdn.test/a.png" })
    storage.files.set(key, AVIF_STUB)
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      {
        storage,
        size: async () => null,
        blurhash: async () => null,
        ...fakeCodec(),
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hit).toBe(true)
    expect(result.width).toBe(0)
    expect(result.height).toBe(0)
    expect(result.blurhash).toBeUndefined()
  })
})

describe("命中路径不再读写 sidecar", () => {
  it("已有 AVIF 本体但没有任何 .json 时，命中照常工作", async () => {
    const storage = memoryStorage()
    const key = imageCacheKey({ url: "https://cdn.test/a.png" })
    storage.files.set(key, AVIF_STUB)
    const codec = fakeCodec()
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, ...codec, ...fakeMeta() },
    )
    expect(result.ok && result.hit).toBe(true)
    expect(codec.calls).toEqual({ download: 0, compress: 0 })
    expect([...storage.files.keys()]).toEqual([key])
  })
})
