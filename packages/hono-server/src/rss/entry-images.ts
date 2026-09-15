import http from "node:http"
import https from "node:https"
import sharp from "sharp"
import { httpAgent, httpsAgent, shouldProxy } from "./parser"
import type { CachedImage } from "../db/types"

// ── 图片缓存全局默认配置（环境变量可覆盖，见 .env.example） ──
// 每个 feed 可在 PostgreSQL feeds 表上按源覆盖这些默认值（见 cacheEntryImages 的 options 参数）。

/** 压缩后最大宽度（保持宽高比，小图不放大） */
const DEFAULT_MAX_IMAGE_WIDTH = parseInt(process.env.MAX_IMAGE_WIDTH ?? "1200")
/** AVIF 编码质量：越低体积越小（正文图片 40-50 即可接受） */
const DEFAULT_AVIF_QUALITY = parseInt(process.env.AVIF_QUALITY ?? "45")
/** 每篇 entry 最多缓存的图片数，超出部分保留原 URL */
const DEFAULT_MAX_IMAGE_COUNT = parseInt(process.env.MAX_IMAGE_COUNT ?? "5")
/** 源图下载大小上限（字节），超出即放弃缓存 */
const DEFAULT_MAX_SOURCE_IMAGE_BYTES = parseInt(process.env.MAX_SOURCE_IMAGE_BYTES ?? "8388608")
/** 单张源图下载超时（毫秒） */
const IMAGE_DOWNLOAD_TIMEOUT = 10_000
/** 下载并发上限 */
const DOWNLOAD_CONCURRENCY = 3
/** 限制输入像素数，防止超大图耗尽内存 */
const MAX_INPUT_PIXELS = 40_000_000

/** 全局默认图片缓存参数（环境变量可覆盖），供前端展示 placeholder 默认值 */
export const DEFAULT_IMAGE_OPTIONS = {
  maxImageCount: DEFAULT_MAX_IMAGE_COUNT,
  maxImageWidth: DEFAULT_MAX_IMAGE_WIDTH,
  avifQuality: DEFAULT_AVIF_QUALITY,
  maxSourceImageBytes: DEFAULT_MAX_SOURCE_IMAGE_BYTES,
} as const

/**
 * 单条目图片缓存的可覆盖配置（per-feed，来自 feeds 表的 image 缓策略字段）。
 * 未提供的字段回退到上方全局默认。
 */
export interface EntryImageOptions {
  /** 每篇最多缓存图片数；0/undefined 且 cacheAll 时表示不限制 */
  maxImageCount?: number
  /** 压缩后最大宽度 px */
  maxImageWidth?: number
  /** AVIF 质量 */
  avifQuality?: number
  /** 源图下载大小上限（字节） */
  maxSourceImageBytes?: number
  /** 是否缓存全部图片（同一 entry 内不设数量上限） */
  cacheAll?: boolean
}

/** 匹配 <img src="...">（含单/双引号，忽略大小写与属性顺序） */
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi

/**
 * 解码 HTML 文本中的常见实体。
 * 正文里的 URL 常带 &amp;（如 ?k=xxx&amp;u=yyy），不解码会导致下载 404；
 * 且浏览器 DOMParser 解析后 getAttribute('src') 天然返回解码值，两端需保持一致。
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

/** nano multipart 写入用的附件数据 */
export interface ImageAttachment {
  name: string
  data: Buffer
  content_type: string
}

/**
 * 从正文 HTML 中提取图片地址：
 * - 过滤 data: URI 与无法解析的地址
 * - 相对路径基于 baseUrl 解析为绝对地址（与前端匹配一致）
 * - 去重，按 limit 截断
 */
export function extractImageUrls(content: string | undefined, baseUrl: string, limit = DEFAULT_MAX_IMAGE_COUNT): string[] {
  if (!content) return []
  const urls: string[] = []
  for (const match of content.matchAll(IMG_SRC_RE)) {
    const raw = decodeHtmlEntities(match[1]!)
    if (raw.startsWith("data:")) continue
    let abs: string
    try {
      abs = new URL(raw, baseUrl).toString()
    } catch {
      continue // 非法地址，跳过
    }
    if (abs.startsWith("data:") || !/^https?:$/.test(new URL(abs).protocol)) continue
    if (!urls.includes(abs)) urls.push(abs)
    if (urls.length >= limit) break
  }
  return urls
}

/** 下载一张图片（跟随重定向，校验 Content-Type，限制大小与超时）；失败返回 null */
async function downloadImage(url: string, maxBytes?: number): Promise<Buffer | null> {
  try {
    let current = url
    // 最多跟随 3 次重定向
    for (let i = 0; i < 4; i++) {
      const res = await httpGet(current, maxBytes)
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).toString()
        continue
      }
      if (res.status !== 200) return null
      const contentType = (res.headers["content-type"] ?? "").toLowerCase()
      if (!contentType.startsWith("image/")) return null
      return res.buffer
    }
    return null
  } catch {
    return null // 网络失败/超时/超限：静默跳过，保留原 URL
  }
}

/** 发起 HTTP(S) GET 并流式收集响应体（超时、大小超限时抛错终止） */
function httpGet(url: string, maxBytes?: number): Promise<{ status: number, headers: http.IncomingHttpHeaders, buffer: Buffer }> {
  // 未显式指定时用全局默认上限
  const limit = maxBytes ?? DEFAULT_MAX_SOURCE_IMAGE_BYTES
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http
    const agent = shouldProxy(url) ? (url.startsWith("https:") ? httpsAgent : httpAgent) : undefined
    const req = mod.get(url, {
      agent,
      timeout: IMAGE_DOWNLOAD_TIMEOUT,
      // 部分图床/防盗链站点拒绝无 UA 请求
      headers: { "User-Agent": "Mozilla/5.0 (compatible; rssfed/1.0)" },
    }, (res) => {
      const chunks: Buffer[] = []
      let total = 0
      res.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > limit) {
          req.destroy(new Error("image too large"))
          return
        }
        chunks.push(chunk)
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }))
      res.on("error", reject)
    })
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
  })
}

/** 压缩为 AVIF 小图；解码失败返回 null（导出供测试） */
export async function compressToAvif(
  buffer: Buffer,
  opts: { maxWidth?: number, quality?: number } = {},
): Promise<{ buffer: Buffer, width: number, height: number } | null> {
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH
  const quality = opts.quality ?? DEFAULT_AVIF_QUALITY
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    if (!meta.width || !meta.height) return null
    const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .avif({ quality })
      .toBuffer()
    const outMeta = await sharp(out).metadata()
    return { buffer: out, width: outMeta.width ?? meta.width, height: outMeta.height ?? meta.height }
  } catch {
    return null // 非图片/损坏数据：跳过
  }
}

/** 单张图片 URL 去重缓存（同进程内相同 URL 只下载压缩一次，如 feed 图标/头像） */
const singleImageCache = new Map<string, Promise<{ image: CachedImage, data: Buffer } | null>>()

/**
 * 下载并压缩单张图片（feed 图标等），返回附件数据与 CachedImage 元数据。
 * 失败返回 null；同 URL 在进程生命周期内只处理一次。
 */
export function cacheSingleImage(url: string): Promise<{ image: CachedImage, data: Buffer } | null> {
  let pending = singleImageCache.get(url)
  if (!pending) {
    pending = (async () => {
      const raw = await downloadImage(url)
      if (!raw) return null
      const result = await compressToAvif(raw)
      if (!result) return null
      return {
        image: { url, attachment: "feed-image.avif", width: result.width, height: result.height },
        data: result.buffer,
      }
    })()
    singleImageCache.set(url, pending)
    pending.finally(() => singleImageCache.delete(url)).catch(() => {})
  }
  return pending
}

/**
 * 下载并压缩正文图片，产出 nano multipart 写入所需的 attachments 与 CachedImage 元数据。
 * 单张图片失败不影响其他图片；全部失败返回空数组（调用方回退为无图 entry）。
 *
 * @param protocolCoverUrl 协议封面（media:thumbnail / 图片 enclosure / JSON Feed image）。
 *   存在且可缓存时作为封面图（cover: true），正文图片仅作内容图；
 *   无协议封面时从正文图中选第一张合格图作为封面。
 * @param options per-feed 图片缓存策略（来自 feeds 表），覆盖全局默认；未提供字段回退全局默认。
 *   cacheAll 为 true 且未设置 maxImageCount 时，同一 entry 内不限制缓存图片数（漫画源全量离线）。
 */
export async function cacheEntryImages(
  content: string | undefined,
  baseUrl: string,
  protocolCoverUrl?: string,
  options: EntryImageOptions = {},
): Promise<{ attachments: ImageAttachment[], images: CachedImage[] }> {
  // 每篇最多缓存图片数：cacheAll 且未显式设置时视为不限制（用极大数近似）
  const maxImageCount = options.cacheAll && !options.maxImageCount
    ? Number.MAX_SAFE_INTEGER
    : (options.maxImageCount ?? DEFAULT_MAX_IMAGE_COUNT)
  const urls = extractImageUrls(content, baseUrl, maxImageCount)
  const attachments: ImageAttachment[] = []
  const images: CachedImage[] = []

  // 协议封面优先：下载压缩为第一张图并标记 cover（失败则静默回退正文选图）
  if (protocolCoverUrl) {
    const raw = await downloadImage(protocolCoverUrl, options.maxSourceImageBytes)
    if (raw) {
      const result = await compressToAvif(raw, { maxWidth: options.maxImageWidth, quality: options.avifQuality })
      if (result) {
        const name = `img-${images.length}.avif`
        attachments.push({ name, data: result.buffer, content_type: "image/avif" })
        images.push({
          url: protocolCoverUrl, attachment: name,
          width: result.width, height: result.height,
          cover: true,
        })
      }
    }
  }

  // 受限并发下载+压缩，避免同一 feed 的大量图片请求压垮连接；
  // 结果按正文出现顺序收集（并发完成顺序不定，封面选择依赖稳定顺序）
  const results: Array<{ url: string, result: { buffer: Buffer, width: number, height: number } } | null> =
    new Array(urls.length).fill(null)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < urls.length) {
      const i = cursor++
      const url = urls[i]!
      // 协议封面已在上面缓存，正文里重复的 URL 跳过
      if (url === protocolCoverUrl) continue
      const raw = await downloadImage(url, options.maxSourceImageBytes)
      if (!raw) continue
      const result = await compressToAvif(raw, { maxWidth: options.maxImageWidth, quality: options.avifQuality })
      if (!result) continue
      results[i] = { url, result }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, urls.length) }, worker))
  for (const r of results) {
    if (!r) continue
    const name = `img-${images.length}.avif`
    attachments.push({ name, data: r.result.buffer, content_type: "image/avif" })
    images.push({ url: r.url, attachment: name, width: r.result.width, height: r.result.height })
  }

  // 无协议封面时，从正文图中选第一张合格图（过滤小 logo/图标）作为封面
  if (!images.some((img) => img.cover)) {
    const MIN_COVER_AREA = 200 * 150
    const cover = images.find((img) => (img.width ?? 0) * (img.height ?? 0) >= MIN_COVER_AREA)
    if (cover) cover.cover = true
  }

  return { attachments, images }
}
