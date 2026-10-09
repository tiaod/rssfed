import { createHash } from "node:crypto"
import { storage as defaultStorage, type Storage } from "../storage"
import {
  compressToAvif,
  downloadImage,
  probeImageSize,
  DEFAULT_AVIF_QUALITY,
  DEFAULT_MAX_IMAGE_WIDTH,
  DEFAULT_MAX_SOURCE_IMAGE_BYTES,
  type ImageFailReason,
} from "./fetch"

/**
 * 图片缓存服务：把「远程图片 URL + 压缩参数」映射成一份**内容寻址**的 AVIF 缓存对象。
 *
 * 存在的理由：改造后同一张正文图会被写进多个地方 —— 源库附件（抓取时按 per-feed 策略）、
 * 每个订阅用户的 timeline 库附件（按该用户的图片策略）。如果每处都重新下载压缩一遍，
 * CPU 与带宽会随用户数线性放大。这里用 `sha256(url + 有效参数)` 做 key 落进 Storage，
 * 于是「同一 URL + 同一参数」全实例只下载压缩一次，路径只是读一个对象。
 *
 * 它不是 HTTP 缓存：没有 TTL、没有失效，key 里带 `IMAGE_CACHE_VERSION`，
 * 改压缩实现（影响已有字节的含义）时递增版本即可让旧对象自然被绕过。
 *
 * 消费方：
 *   - `rss/entry-images.ts`（源库附件，抓取路径）
 *   - `services/timeline.ts`（用户 timeline 库附件，聚合路径）
 *   - `GET /api/images/cached`（按需压缩，浏览器/客户端直取）
 */

/** 缓存 key 的版本：改 key 结构或压缩实现语义时 +1（旧对象随即失效） */
export const IMAGE_CACHE_VERSION = 1

/** 缓存对象在 Storage 里的前缀（与上传类附件的 key 空间分开，便于按前缀清理/统计） */
export const IMAGE_CACHE_PREFIX = "image-cache"

/** 压缩参数的有效范围（路由侧同样用它校验 query，避免非法参数各写一份） */
export const IMAGE_PARAM_LIMITS = {
  minWidth: 16,
  maxWidth: 4096,
  minQuality: 1,
  maxQuality: 100,
} as const

/** 单张图的压缩请求：url 必填，参数缺省时走全局默认（见 images/fetch.ts） */
export interface CompressedImageRequest {
  url: string
  maxWidth?: number
  quality?: number
  maxSourceBytes?: number
}

/** 压缩后的图片本体与元数据 */
export interface CompressedImage {
  /** Storage 里的对象 key（AVIF 本体）。尺寸元数据在同 key + `.json` */
  key: string
  buffer: Buffer
  contentType: "image/avif"
  width: number
  height: number
  sourceUrl: string
  /** 是否命中已有缓存（false = 这次真的下载并压缩了） */
  hit: boolean
}

export type CompressedImageResult =
  | ({ ok: true } & CompressedImage)
  | { ok: false, reason: ImageFailReason }

/** 依赖注入点（测试用；生产走默认实现） */
export interface ImageCacheDeps {
  storage?: Storage
  download?: typeof downloadImage
  compress?: typeof compressToAvif
  size?: typeof probeImageSize
}

/** 同进程内同一 key 的并发合并：同一批条目里重复出现的图片不必压两遍 */
const inflight = new Map<string, Promise<CompressedImageResult>>()

/**
 * 把参数补齐成有效值。
 *
 * 必须**先补齐再算 key**：`{quality: undefined}` 与 `{quality: 45}` 若算出不同 key，
 * 同一个默认参数就会产出两份缓存对象。
 */
export function normalizeImageRequest(req: CompressedImageRequest) {
  return {
    url: req.url,
    maxWidth: req.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH,
    quality: req.quality ?? DEFAULT_AVIF_QUALITY,
    maxSourceBytes: req.maxSourceBytes ?? DEFAULT_MAX_SOURCE_IMAGE_BYTES,
  }
}

/**
 * 缓存 key（纯函数，便于单测）。
 *
 * 只把**影响输出字节**的参数放进哈希：`maxSourceBytes` 只决定「这张图还下不下」，
 * 不影响压缩结果，放进 key 只会让同一张图按下载上限裂成多份。
 */
export function imageCacheKey(req: CompressedImageRequest): string {
  const { url, maxWidth, quality } = normalizeImageRequest(req)
  const hash = createHash("sha256").update(`${url}\n${maxWidth}\n${quality}`).digest("hex")
  return `${IMAGE_CACHE_PREFIX}/v${IMAGE_CACHE_VERSION}/${hash}.avif`
}

/** 判断地址是否是可下载的 http(s) 地址（挡掉 file:/data:/javascript: 等） */
export function isFetchableImageUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/**
 * 是否指向本机 / 私有网段 / 链路本地地址（含云元数据地址）。
 *
 * 只用于**对外接口**的兜底（见 routes/images.ts）：内部抓取路径不加这道门，
 * 因为正文图本来就可能来自内网里的自建图床/RSSHub —— 那些地址是订阅源内容带进来的，
 * 与「任何登录用户都能让服务端请求任意 URL」是两件事。按主机名字面量判断，
 * 不做 DNS 解析（DNS rebinding 不在本层防御范围内）。
 */
export function isPrivateHost(raw: string): boolean {
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return true // 解析不了的一律按危险处理
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true // IPv6 链路本地/唯一本地
  // IPv4（含 127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、0.0.0.0）
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** 直接按 key 读缓存对象（路由命中路径用；不存在返回 null） */
export async function readCachedImage(key: string, deps: ImageCacheDeps = {}): Promise<{ content: Buffer, contentType: string } | null> {
  const store = deps.storage ?? defaultStorage
  try {
    return await store.readWithMeta(key)
  } catch {
    return null
  }
}

/**
 * 取一张压缩后的图片：命中缓存直接返回，未命中则下载 + 压缩 + 落盘。
 *
 * 失败一律以 `{ ok:false, reason }` 返回（不抛错）：调用方是批量聚合循环，
 * 单张失败只该记一次原因，不该中断整批。
 *
 * `allowPrivateHosts=false` 时拒绝内网地址（对外接口用，见 isPrivateHost）。
 */
export async function getCompressedImage(
  req: CompressedImageRequest,
  deps: ImageCacheDeps & { allowPrivateHosts?: boolean } = {},
): Promise<CompressedImageResult> {
  const { url, maxWidth, quality, maxSourceBytes } = normalizeImageRequest(req)
  if (!isFetchableImageUrl(url)) return { ok: false, reason: "invalid-url" }
  if (deps.allowPrivateHosts === false && isPrivateHost(url)) return { ok: false, reason: "invalid-url" }

  const key = imageCacheKey(req)
  const pending = inflight.get(key)
  if (pending) return pending

  const store = deps.storage ?? defaultStorage
  const download = deps.download ?? downloadImage
  const compress = deps.compress ?? compressToAvif
  const probeSize = deps.size ?? probeImageSize

  const task = (async (): Promise<CompressedImageResult> => {
    // ① 命中：本体在就行，尺寸元数据缺失时现算（老对象 / 元数据写失败）
    const cached = await readCachedImage(key, { storage: store })
    if (cached) {
      const meta = await readCachedMeta(key, store)
      const size = meta ?? await probeSize(cached.content)
      return {
        ok: true,
        key,
        buffer: cached.content,
        contentType: "image/avif",
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        sourceUrl: meta?.sourceUrl ?? url,
        hit: true,
      }
    }

    // ② 未命中：下载 → 压缩 → 落盘（先本体后元数据：元数据缺失可由本体补，反之不行）
    const outcome = await download(url, maxSourceBytes)
    if (!outcome.buffer) return { ok: false, reason: outcome.reason ?? "network" }
    const compressed = await compress(outcome.buffer, { maxWidth, quality })
    if (!compressed) return { ok: false, reason: "decode" }
    // 落盘失败只降级为「这次没缓存」：缓存是加速手段，不该让它把可用性拖下水
    //（对象存储抖动 / 本地盘满 / 测试里没配 Storage 都走这里）
    await store.write(compressed.buffer, key, "image/avif").catch(() => {})
    await store
      .write(
        Buffer.from(JSON.stringify({ sourceUrl: url, width: compressed.width, height: compressed.height, maxWidth, quality, createdAt: new Date().toISOString() })),
        `${key}.json`,
        "application/json",
      )
      .catch(() => {
        // 元数据写失败不影响使用（下次读本体现算尺寸）
      })
    return {
      ok: true,
      key,
      buffer: compressed.buffer,
      contentType: "image/avif",
      width: compressed.width,
      height: compressed.height,
      sourceUrl: url,
      hit: false,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/** 读尺寸元数据 sidecar；不存在或损坏返回 null */
async function readCachedMeta(key: string, store: Storage): Promise<{ sourceUrl?: string, width?: number, height?: number } | null> {
  try {
    const raw = await store.read(`${key}.json`)
    const parsed = JSON.parse(raw.toString("utf8")) as { sourceUrl?: string, width?: number, height?: number }
    return parsed
  } catch {
    return null
  }
}
