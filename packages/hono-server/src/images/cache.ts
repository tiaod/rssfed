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
import { blurhashFromImage } from "./blurhash"

/**
 * 图片缓存：把「远程图片 URL + 压缩参数」映射成一份**内容寻址**的 AVIF 缓存对象。
 *
 * 唯一消费者是抓取路径（`rss/entry-images.ts`）：同一条图片 URL 会在多个条目里重复出现
 * （公众号文章内嵌的模板图、站点图标等），第二次起直接读缓存对象，不再下载 + 压缩。
 * 缓存对象只是**中间产物** —— 条目真正要的是 CouchDB 附件；缓存只为省重复的下载/编码。
 *
 * 因为它可以随时重建，所以允许过期：老对象由 `images/cache-gc.ts` 按
 * `IMAGE_CACHE_TTL_DAYS`（默认 30 天）清掉；清掉之后最多是「下次遇到同 URL 时重下一遍」，
 * 不影响任何已入库数据。key 里带 `IMAGE_CACHE_VERSION`，改压缩实现时递增版本即可让旧对象失效。
 *
 * 没有 sidecar 元数据：命中时用 `probeImageSize` / `blurhashFromImage` 从 AVIF 本体现算
 * （头部解码是毫秒级），省掉每张图一个 JSON 对象的写与读。
 */

/** 缓存 key 的版本：改 key 结构或压缩实现语义时 +1（旧对象随即失效） */
export const IMAGE_CACHE_VERSION = 1

/** 缓存对象在 Storage 里的前缀（与上传类附件的 key 空间分开，便于按前缀清理/统计） */
export const IMAGE_CACHE_PREFIX = "image-cache"

/** 单张图的压缩请求：url 必填，参数缺省时走全局默认（见 images/fetch.ts） */
export interface CompressedImageRequest {
  url: string
  maxWidth?: number
  quality?: number
  maxSourceBytes?: number
}

/** 压缩后的图片本体与元数据 */
export interface CompressedImage {
  /** Storage 里的对象 key（AVIF 本体） */
  key: string
  buffer: Buffer
  contentType: "image/avif"
  width: number
  height: number
  sourceUrl: string
  /** 是否命中已有缓存（false = 这次真的下载并压缩了） */
  hit: boolean
  /**
   * 占位图用的 BlurHash（见 images/blurhash.ts）。
   * 命中路径同样现场计算（不再有 sidecar 可读）；算不出来时为 undefined，
   * 前端退化为透明占位，不影响取图本身。
   */
  blurhash?: string
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
  blurhash?: typeof blurhashFromImage
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

/** 按 key 读缓存本体；不存在或读失败一律返回 null（缓存是加速手段，不该把可用性拖下水） */
async function readCachedBody(key: string, store: Storage): Promise<Buffer | null> {
  try {
    return (await store.readWithMeta(key)).content
  } catch {
    return null
  }
}

/**
 * 取一张压缩后的图片：命中缓存直接返回，未命中则下载 + 压缩 + 落盘。
 *
 * 失败一律以 `{ ok:false, reason }` 返回（不抛错）：调用方是批量聚合循环，
 * 单张失败只该记一次原因，不该中断整批。
 */
export async function getCompressedImage(
  req: CompressedImageRequest,
  deps: ImageCacheDeps = {},
): Promise<CompressedImageResult> {
  const { url, maxWidth, quality, maxSourceBytes } = normalizeImageRequest(req)
  if (!isFetchableImageUrl(url)) return { ok: false, reason: "invalid-url" }

  const key = imageCacheKey(req)
  const pending = inflight.get(key)
  if (pending) return pending

  const store = deps.storage ?? defaultStorage
  const download = deps.download ?? downloadImage
  const compress = deps.compress ?? compressToAvif
  const probeSize = deps.size ?? probeImageSize
  const makeBlurhash = deps.blurhash ?? blurhashFromImage

  const task = (async (): Promise<CompressedImageResult> => {
    // ① 命中：本体在就够了，尺寸与 blurhash 从 AVIF 现算
    const cached = await readCachedBody(key, store)
    if (cached) {
      const size = await probeSize(cached)
      const blurhash = (await makeBlurhash(cached)) ?? undefined
      return {
        ok: true,
        key,
        buffer: cached,
        contentType: "image/avif",
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        sourceUrl: url,
        hit: true,
        blurhash,
      }
    }

    // ② 未命中：下载 → 压缩 → 落盘
    const outcome = await download(url, maxSourceBytes)
    if (!outcome.buffer) return { ok: false, reason: outcome.reason ?? "network" }
    const compressed = await compress(outcome.buffer, { maxWidth, quality })
    if (!compressed) return { ok: false, reason: "decode" }
    const blurhash = (await makeBlurhash(compressed.buffer)) ?? undefined
    // 落盘失败只降级为「这次没缓存」：缓存是加速手段，不该让它把可用性拖下水
    //（对象存储抖动 / 本地盘满 / 测试里没配 Storage 都走这里）
    await store.write(compressed.buffer, key, "image/avif").catch(() => {})
    return {
      ok: true,
      key,
      buffer: compressed.buffer,
      contentType: "image/avif",
      width: compressed.width,
      height: compressed.height,
      sourceUrl: url,
      hit: false,
      blurhash,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}
