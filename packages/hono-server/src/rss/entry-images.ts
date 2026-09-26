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
/**
 * 每篇 entry 最多尝试缓存的图片数。
 *
 * 主约束已改为「每篇附件总体积预算」（见 DEFAULT_MAX_ENTRY_IMAGE_BYTES），
 * 这个值退化为**请求数硬顶**：预算要压缩完才知道大小，一篇上万张 1KB 小图
 * 在填满预算之前会发出海量请求，必须有个上限兜住。
 */
const DEFAULT_MAX_IMAGE_COUNT = parseInt(process.env.MAX_IMAGE_COUNT ?? "200")
/**
 * 每篇 entry 缓存的附件**总体积**上限（压缩后字节）—— 主约束。
 *
 * 相比「每篇 N 张」，体积预算更贴近真实成本：小图（p50 约 19KB）能存几十张，
 * 大图自然少存几 张。实测模拟（report/image-cache-diagnosis）：1MB 预算可覆盖
 * 93.4% 的正文图、被截断 140 条；同等覆盖率下比固定 20 张省约 110MB。
 */
const DEFAULT_MAX_ENTRY_IMAGE_BYTES = parseInt(process.env.MAX_ENTRY_IMAGE_BYTES ?? String(1024 * 1024))
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
  maxEntryImageBytes: DEFAULT_MAX_ENTRY_IMAGE_BYTES,
  maxImageWidth: DEFAULT_MAX_IMAGE_WIDTH,
  avifQuality: DEFAULT_AVIF_QUALITY,
  maxSourceImageBytes: DEFAULT_MAX_SOURCE_IMAGE_BYTES,
} as const

/**
 * 单条目图片缓存的可覆盖配置（per-feed，来自 feeds 表的 image 缓策略字段）。
 * 未提供的字段回退到上方全局默认。
 */
export interface EntryImageOptions {
  /** 每篇最多尝试缓存的图片数（请求数硬顶）；cacheAll 时视为不限制 */
  maxImageCount?: number
  /** 每篇附件总体积上限（压缩后字节）——主约束；cacheAll 时视为不限制 */
  maxEntryImageBytes?: number
  /** 压缩后最大宽度 px */
  maxImageWidth?: number
  /** AVIF 质量 */
  avifQuality?: number
  /** 源图下载大小上限（字节） */
  maxSourceImageBytes?: number
  /** 是否缓存全部图片（同一 entry 内不设数量与体积上限，漫画源全量离线） */
  cacheAll?: boolean
}

/** 匹配 <img src="...">（含单/双引号，忽略大小写与属性顺序） */
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi

/** 图片扩展名兜底（见 looksLikeImage） */
const IMAGE_EXT_RE = /\.(?:avif|webp|png|jpe?g|gif|bmp|tiff?)(?:$|[?#])/i

/**
 * 判断响应是否可能是图片。
 *
 * 只看 `Content-Type: image/*` 会漏掉一批图床：实测 storage.googleapis.com 返回
 * `application/octet-stream`，占失败抽样 URL 的 28%。所以补一层 URL 扩展名兜底，
 * 同时显式拒绝 text/* 与 json/xml/html（避免把防盗链错误页喂给 sharp）。
 * 最终仍由 sharp 解码裁决：解不出来就按 decode 失败跳过，不会写入坏附件。
 */
function looksLikeImage(url: string, contentType: string): boolean {
  if (contentType.startsWith("image/")) return true
  if (/^(?:text\/|application\/(?:json|xml|html))/i.test(contentType)) return false
  return IMAGE_EXT_RE.test(url)
}

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
 * 图片下载/压缩失败原因。
 * 这些路径原先全部静默返回 null，导致「为什么没缓存」只能靠反推（见
 * report/image-cache-diagnosis），所以把原因带出来供 worker 聚合成一行日志。
 */
export type ImageFailReason =
  /** 非 200：403 防盗链 / 404 下线 / 5xx */
  | "http-status"
  /** 响应不是图片（html 错误页、octet-stream 且 URL 无图片扩展名） */
  | "content-type"
  /** 源图超过 maxSourceImageBytes，流式读取时被截断放弃 */
  | "too-large"
  /** 连接或读取空闲超时 */
  | "timeout"
  /** DNS 失败、连接重置等网络错误 */
  | "network"
  /** 重定向超过 3 次 */
  | "redirect-limit"
  /** sharp 解不出来（损坏数据、或像素数超 MAX_INPUT_PIXELS） */
  | "decode"

/** 单条目图片缓存的统计结果，由 worker 汇总后打一行日志 */
export interface EntryImageStats {
  /** 正文图候选数（去重、绝对化、已按请求数硬顶截断） */
  candidates: number
  /** 因请求数硬顶（maxImageCount）未纳入缓存的张数 */
  skippedByLimit: number
  /** 因附件总体积预算（maxEntryImageBytes）未纳入缓存的张数 */
  skippedByBudget: number
  /** 成功写入附件的张数（**含协议封面**，可能比 candidates 多 1） */
  cached: number
  /** 失败张数（协议封面 + 正文图） */
  failed: number
  /** 失败原因计数 */
  reasons: Partial<Record<ImageFailReason, number>>
  /** 附件总字节（压缩后） */
  bytes: number
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

/** 下载结果：成功带 buffer，失败带原因（供聚合统计） */
interface DownloadOutcome {
  buffer: Buffer | null
  reason?: ImageFailReason
}

/** 下载一张图片（跟随重定向，校验是否图片，限制大小与超时） */
async function downloadImage(url: string, maxBytes?: number): Promise<DownloadOutcome> {
  try {
    let current = url
    // 最多跟随 3 次重定向
    for (let i = 0; i < 4; i++) {
      const res = await httpGet(current, maxBytes)
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).toString()
        continue
      }
      if (res.status !== 200) return { buffer: null, reason: "http-status" }
      const contentType = (res.headers["content-type"] ?? "").toLowerCase()
      // 扩展名兜底：部分图床把图片标成 application/octet-stream（见 looksLikeImage）
      if (!looksLikeImage(current, contentType)) return { buffer: null, reason: "content-type" }
      return { buffer: res.buffer }
    }
    return { buffer: null, reason: "redirect-limit" }
  } catch (err) {
    // 网络失败/超时/超限：跳过该图并带上原因，不阻塞其余图片
    const msg = (err as Error).message
    if (msg === "image too large") return { buffer: null, reason: "too-large" }
    if (msg === "timeout") return { buffer: null, reason: "timeout" }
    return { buffer: null, reason: "network" }
  }
}

/** 发起 HTTP(S) GET 并流式收集响应体（超时、大小超限时抛错终止） */
function httpGet(url: string, maxBytes?: number): Promise<{ status: number, headers: http.IncomingHttpHeaders, buffer: Buffer }> {
  // 未显式指定时用全局默认上限
  const limit = maxBytes ?? DEFAULT_MAX_SOURCE_IMAGE_BYTES
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http
    const agent = shouldProxy(url) ? (url.startsWith("https:") ? httpsAgent : httpAgent) : undefined
    // 只让第一个结果生效：主动断开连接后还会冒出 error/close 事件，不能覆盖已定结论
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
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
          fail(new Error("image too large"))
          // 关键：destroy **不传 Error**。传了会 emit 出 error 事件，实测在超限路径上
          // 会产生未接管的 error（vitest 直接报 unhandled）；不传则只安静关闭连接。
          res.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on("end", () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) })
      })
      res.on("error", fail)
    })
    req.on("timeout", () => {
      fail(new Error("timeout"))
      req.destroy()
    })
    req.on("error", fail)
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

/**
 * feed 图标（侧边栏/列表头像）的目标宽度。
 *
 * 侧边栏把图标渲染成约 20px 的头像，而 compressToAvif 的默认上限是 1200px（正文图片用），
 * 两者错配的代价很大：实测 300 张 1200px AVIF 解码会阻塞主线程 1.0–5.3 秒，
 * 而 64px/190px 都是 0–15ms（AVIF 解码开销随像素数超线性增长）。
 * 64px 足够覆盖 3x 屏幕密度下的 20px 头像。
 */
const FEED_ICON_MAX_WIDTH = parseInt(process.env.FEED_ICON_MAX_WIDTH ?? "64")

/**
 * feed 图标压缩参数版本。
 *
 * 改 FEED_ICON_MAX_WIDTH 或压缩质量时必须 +1：worker 只在
 * `imageCached.v !== FEED_ICON_CACHE_VERSION` 时重新压缩，
 * 否则已缓存的图标会一直停留在老参数上（附件名固定为 feed-image.avif，
 * 光靠 URL 比较发现不了参数变化）。
 *
 * v2：图标从「继承正文图片的 1200px 上限」改为 64px。
 */
export const FEED_ICON_CACHE_VERSION = 2

/** 单张图片 URL 去重缓存（同进程内相同 URL 只下载压缩一次，如 feed 图标/头像） */
const singleImageCache = new Map<string, Promise<{ image: CachedImage, data: Buffer } | null>>()

/**
 * 下载并压缩单张图片（feed 图标等），返回附件数据与 CachedImage 元数据。
 * 失败返回 null；同 URL + 同参数版本在进程生命周期内只处理一次。
 */
export function cacheSingleImage(url: string): Promise<{ image: CachedImage, data: Buffer } | null> {
  // 缓存键带上参数版本：同进程内改了压缩参数也要重新压，不能命中旧结果
  const cacheKey = `${url}|v${FEED_ICON_CACHE_VERSION}`
  let pending = singleImageCache.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const outcome = await downloadImage(url)
      if (!outcome.buffer) return null
      const result = await compressToAvif(outcome.buffer, { maxWidth: FEED_ICON_MAX_WIDTH })
      if (!result) return null
      return {
        image: {
          url,
          attachment: "feed-image.avif",
          width: result.width,
          height: result.height,
          v: FEED_ICON_CACHE_VERSION,
        },
        data: result.buffer,
      }
    })()
    singleImageCache.set(cacheKey, pending)
    pending.finally(() => singleImageCache.delete(cacheKey)).catch(() => {})
  }
  return pending
}

/**
 * 下载并压缩正文图片，产出 nano multipart 写入所需的 attachments 与 CachedImage 元数据。
 * 单张图片失败不影响其他图片；全部失败返回空数组（调用方回退为无图 entry）。
 *
 * 返回值里的 `stats` 是本次处理的失败原因汇总：这些路径原先静默返回 null，
 * 「为什么没缓存」只能靠离线反推（见 report/image-cache-diagnosis），
 * 由 worker 聚合后打一行日志即可定位。
 *
 * @param protocolCoverUrl 协议封面（media:thumbnail / 图片 enclosure / JSON Feed image）。
 *   存在且可缓存时作为封面图（cover: true），正文图片仅作内容图；
 *   无协议封面时从正文图中选第一张合格图作为封面。
 * @param options per-feed 图片缓存策略（来自 feeds 表），覆盖全局默认；未提供字段回退全局默认。
 *   cacheAll 为 true 时数量与体积都不限制（漫画源全量离线）。
 */
export async function cacheEntryImages(
  content: string | undefined,
  baseUrl: string,
  protocolCoverUrl?: string,
  options: EntryImageOptions = {},
): Promise<{ attachments: ImageAttachment[], images: CachedImage[], stats: EntryImageStats }> {
  // 张数是请求数硬顶；cacheAll（漫画源全量离线）时数量与体积都不限
  const maxImageCount = options.maxImageCount
    ?? (options.cacheAll ? Number.MAX_SAFE_INTEGER : DEFAULT_MAX_IMAGE_COUNT)
  const budget = options.maxEntryImageBytes
    ?? (options.cacheAll ? Number.POSITIVE_INFINITY : DEFAULT_MAX_ENTRY_IMAGE_BYTES)
  // 先取全量候选再截断：这样才能把「因硬顶/预算跳过」与「下载失败」分开统计
  const allUrls = extractImageUrls(content, baseUrl, Number.MAX_SAFE_INTEGER)
  const urls = allUrls.length > maxImageCount ? allUrls.slice(0, maxImageCount) : allUrls
  const attachments: ImageAttachment[] = []
  const images: CachedImage[] = []
  const reasons: Partial<Record<ImageFailReason, number>> = {}
  let failed = 0
  /** 已累计的附件体积（压缩后），预算判断的唯一依据 */
  let budgetUsed = 0
  let skippedByBudget = 0
  /** 记一次失败（含原因），供末尾聚合 */
  const bump = (reason: ImageFailReason): void => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
    failed++
  }

  // 协议封面优先：下载压缩为第一张图并标记 cover（失败则回退正文选图，并记下原因）。
  // 封面不参与体积判断之外的取舍 —— 即使它单张超过预算也保留，否则整篇会没图。
  if (protocolCoverUrl) {
    const outcome = await downloadImage(protocolCoverUrl, options.maxSourceImageBytes)
    if (!outcome.buffer) {
      bump(outcome.reason ?? "network")
    } else {
      const result = await compressToAvif(outcome.buffer, { maxWidth: options.maxImageWidth, quality: options.avifQuality })
      if (!result) {
        bump("decode")
      } else {
        const name = `img-${images.length}.avif`
        attachments.push({ name, data: result.buffer, content_type: "image/avif" })
        images.push({
          url: protocolCoverUrl, attachment: name,
          width: result.width, height: result.height,
          cover: true,
        })
        budgetUsed += result.buffer.length
      }
    }
  }

  // 分批并发下载+压缩，批间按正文顺序累计体积，超预算即停止后续批次。
  //
  // 为什么分批而不是继续一把并发：预算只有压缩完才知道大小，必须先算完一批才能决定
  // 下一批还要不要下。批大小取 DOWNLOAD_CONCURRENCY，最坏浪费一批的带宽/CPU。
  // 结果按正文出现顺序收集（并发完成顺序不定，封面选择依赖稳定顺序）。
  type BatchOutcome = { url: string, result?: { buffer: Buffer, width: number, height: number }, reason?: ImageFailReason }
  const results: Array<{ url: string, result: { buffer: Buffer, width: number, height: number } } | null> =
    new Array(urls.length).fill(null)
  let budgetExhausted = false
  for (let start = 0; start < urls.length && !budgetExhausted; start += DOWNLOAD_CONCURRENCY) {
    const batch = urls.slice(start, start + DOWNLOAD_CONCURRENCY)
    const outcomes = await Promise.all(batch.map(async (url): Promise<BatchOutcome | null> => {
      // 协议封面已在上面缓存，正文里重复的 URL 跳过
      if (url === protocolCoverUrl) return null
      const outcome = await downloadImage(url, options.maxSourceImageBytes)
      if (!outcome.buffer) return { url, reason: outcome.reason ?? "network" }
      const result = await compressToAvif(outcome.buffer, { maxWidth: options.maxImageWidth, quality: options.avifQuality })
      if (!result) return { url, reason: "decode" }
      return { url, result }
    }))
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k]
      if (!o) continue
      if (o.reason || !o.result) {
        bump(o.reason ?? "network")
        continue
      }
      const size = o.result.buffer.length
      // 首图必留：budgetUsed 为 0 时（无协议封面且这是第一张）即使超预算也存
      if (budgetUsed > 0 && budgetUsed + size > budget) {
        budgetExhausted = true
        skippedByBudget = urls.length - (start + k)
        break
      }
      budgetUsed += size
      results[start + k] = { url: o.url, result: o.result }
    }
  }
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

  let bytes = 0
  for (const a of attachments) bytes += a.data.length

  return {
    attachments,
    images,
    stats: {
      candidates: urls.length,
      skippedByLimit: allUrls.length - urls.length,
      skippedByBudget,
      cached: images.length,
      failed,
      reasons,
      bytes,
    },
  }
}
