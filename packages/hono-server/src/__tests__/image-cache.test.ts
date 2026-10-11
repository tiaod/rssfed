import { describe, expect, it, vi } from "vitest"
import {
  getCompressedImage,
  imageCacheKey,
  isFetchableImageUrl,
  isPrivateHost,
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
    getPublicUrl: () => undefined,
  }
}

const AVIF_STUB = Buffer.from("avif-bytes")

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
      return { buffer: AVIF_STUB, width: 800, height: 600 }
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

describe("isFetchableImageUrl / isPrivateHost", () => {
  it("只放行 http(s)", () => {
    expect(isFetchableImageUrl("https://x.test/a.png")).toBe(true)
    expect(isFetchableImageUrl("http://x.test/a.png")).toBe(true)
    expect(isFetchableImageUrl("file:///etc/passwd")).toBe(false)
    expect(isFetchableImageUrl("data:image/png;base64,AAAA")).toBe(false)
    expect(isFetchableImageUrl("not a url")).toBe(false)
  })

  it("识别本机 / 私有网段 / 云元数据地址", () => {
    for (const url of [
      "http://localhost/a.png",
      "http://foo.localhost/a.png",
      "http://127.0.0.1/a.png",
      "http://10.1.2.3/a.png",
      "http://172.16.0.9/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[::1]/a.png",
    ]) {
      expect(isPrivateHost(url), url).toBe(true)
    }
    for (const url of ["https://cdn.example.com/a.png", "http://172.32.0.1/a.png", "http://8.8.8.8/a.png"]) {
      expect(isPrivateHost(url), url).toBe(false)
    }
  })
})

describe("getCompressedImage", () => {
  it("未命中：下载 + 压缩 + 落盘（本体与尺寸元数据），返回 hit=false", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, download: codec.download, compress: codec.compress },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hit).toBe(false)
    expect(result.width).toBe(800)
    expect(result.buffer).toEqual(AVIF_STUB)
    expect(storage.files.has(result.key)).toBe(true)
    expect(storage.files.has(`${result.key}.json`)).toBe(true)
    expect(codec.calls).toEqual({ download: 1, compress: 1 })
  })

  it("第二次取同一 URL + 参数：命中缓存，不再下载", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const deps = { storage, download: codec.download, compress: codec.compress }
    const first = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)
    const second = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.hit).toBe(true)
    expect(second.key).toBe(first.key)
    expect(second.width).toBe(800) // 尺寸来自 sidecar，不必重新解码
    expect(codec.calls).toEqual({ download: 1, compress: 1 })
  })

  it("并发同一 URL：合并成一次下载", async () => {
    const storage = memoryStorage()
    const codec = fakeCodec()
    const deps = { storage, download: codec.download, compress: codec.compress }
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
      { storage: memoryStorage(), download: codec.download, compress: codec.compress },
    )
    expect(result).toEqual({ ok: false, reason: "invalid-url" })
    expect(codec.calls.download).toBe(0)
  })

  it("allowPrivateHosts=false 时挡住内网地址（对外接口的默认行为）", async () => {
    const codec = fakeCodec()
    const result = await getCompressedImage(
      { url: "http://127.0.0.1:8080/a.png" },
      { storage: memoryStorage(), download: codec.download, compress: codec.compress, allowPrivateHosts: false },
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
      { storage, download: fakeCodec().download, compress: fakeCodec().compress },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.buffer).toEqual(AVIF_STUB)
  })

  it("命中本体但缺 sidecar 时用解码补尺寸", async () => {
    const storage = memoryStorage()
    const key = imageCacheKey({ url: "https://cdn.test/a.png" })
    storage.files.set(key, AVIF_STUB)
    const size = vi.fn(async () => ({ width: 320, height: 240 }))
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, size, download: fakeCodec().download, compress: fakeCodec().compress },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hit).toBe(true)
    expect(result.width).toBe(320)
    expect(size).toHaveBeenCalledTimes(1)
  })

  it("未命中：blurhash 与压缩字节一起落 sidecar 并随结果返回", async () => {
    const storage = memoryStorage()
    const makeBlurhash = vi.fn(async () => "L43yGppefQpepyflfQflfQfQfQfQ")
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      { storage, download: fakeCodec().download, compress: fakeCodec().compress, blurhash: makeBlurhash },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blurhash).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
    const sidecar = JSON.parse(storage.files.get(`${result.key}.json`)!.toString("utf8"))
    expect(sidecar.blurhash).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
    expect(makeBlurhash).toHaveBeenCalledTimes(1)
  })

  it("命中：blurhash 直接读 sidecar，不重新解码", async () => {
    const storage = memoryStorage()
    const makeBlurhash = vi.fn(async () => "L43yGppefQpepyflfQflfQfQfQfQ")
    const deps = { storage, download: fakeCodec().download, compress: fakeCodec().compress, blurhash: makeBlurhash }
    await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)
    const second = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.hit).toBe(true)
    expect(second.blurhash).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
    expect(makeBlurhash).toHaveBeenCalledTimes(1) // 只有未命中那一次
  })

  it("老对象的 sidecar 没有 blurhash：命中时现算并回写（下次直接读）", async () => {
    const storage = memoryStorage()
    const key = imageCacheKey({ url: "https://cdn.test/a.png" })
    storage.files.set(key, AVIF_STUB)
    // 先前的版本写下的 sidecar：只有来源与尺寸
    storage.files.set(
      `${key}.json`,
      Buffer.from(JSON.stringify({ sourceUrl: "https://cdn.test/a.png", width: 800, height: 600 })),
    )
    const makeBlurhash = vi.fn(async () => "L43yGppefQpepyflfQflfQfQfQfQ")
    const deps = { storage, download: fakeCodec().download, compress: fakeCodec().compress, blurhash: makeBlurhash }

    const first = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)
    expect(first.ok && first.blurhash).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
    // 回写保留了原有字段
    const rewritten = JSON.parse(storage.files.get(`${key}.json`)!.toString("utf8"))
    expect(rewritten).toMatchObject({ sourceUrl: "https://cdn.test/a.png", width: 800, height: 600 })

    const second = await getCompressedImage({ url: "https://cdn.test/a.png" }, deps)
    expect(second.ok && second.blurhash).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
    expect(makeBlurhash).toHaveBeenCalledTimes(1) // 第二次读回写好的 sidecar
  })

  it("算不出 blurhash 时结果与 sidecar 都不带该字段（前端退化为透明占位）", async () => {
    const storage = memoryStorage()
    const result = await getCompressedImage(
      { url: "https://cdn.test/a.png" },
      {
        storage,
        download: fakeCodec().download,
        compress: fakeCodec().compress,
        blurhash: async () => null,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blurhash).toBeUndefined()
    const sidecar = JSON.parse(storage.files.get(`${result.key}.json`)!.toString("utf8"))
    expect(sidecar.blurhash).toBeUndefined()
  })
})
