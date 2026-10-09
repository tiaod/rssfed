import type { CachedImage } from "../db/types"
import { getCompressedImage, type CompressedImageResult } from "../images/cache"
import {
  DEFAULT_AVIF_QUALITY,
  DEFAULT_MAX_IMAGE_WIDTH,
  DEFAULT_MAX_SOURCE_IMAGE_BYTES,
  type ImageFailReason,
} from "../images/fetch"

/**
 * 条目图片缓存：**按源（feed）的策略**决定一篇正文里缓存哪些图、缓存成什么参数。
 *
 * 下载/压缩的原语与内容寻址缓存在 `images/` 下（见 images/fetch.ts 与 images/cache.ts）：
 * 这里只管「策略」—— 请求数硬顶、体积预算、封面选择、失败原因聚合。
 * 同一张图在源库与各用户 timeline 库里用的是**同一份**压缩字节（cache 服务去重），
 * 所以这里改参数只会产生新的缓存对象，不会让已缓存的其他参数组合失效。
 */

// ── 条目图片缓存的全局默认（环境变量可覆盖，见 .env.example） ──
// 每个 feed 可在 PostgreSQL feeds 表上按源覆盖这些默认值（管理员维护，见 cacheEntryImages
// 的 options 参数）。这是**唯一**一处图片策略：抓取时按它把正文图压成附件写进源库，
// 聚合只把成品搬进各用户库（见 services/timeline.ts），用户没有自己的图片参数。

/**
 * 每篇 entry 最多尝试缓存的图片数。
 *
 * 主约束是「每篇附件总体积预算」（见 DEFAULT_MAX_ENTRY_IMAGE_BYTES），
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
/** 下载并发上限 */
const DOWNLOAD_CONCURRENCY = 3

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
 * 图片下载/压缩失败原因（定义见 images/fetch.ts）。
 *
 * 这些路径原先全部静默返回 null，导致「为什么没缓存」只能靠反推（见
 * report/image-cache-diagnosis），所以把原因带出来供 worker 聚合成一行日志。
 */
export type { ImageFailReason }

/**
 * 单条目图片缓存的统计结果，由 worker 汇总后打一行日志
 */
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

/** 取图结果（策略层内部用）：成功带压缩字节与尺寸，失败带可聚合的原因 */
type FetchedImage =
  | { ok: true, buffer: Buffer, width: number, height: number }
  | { ok: false, reason: ImageFailReason }

/**
 * 取一张已压缩图片（命中内容寻址缓存则不发请求）。
 *
 * 把 `CompressedImageResult` 收敛成策略层关心的形状：缓存命中与否不影响它在
 * 预算/封面上的判断，这里只回答「拿到字节没有、没拿到是什么原因」。
 */
async function fetchCompressed(url: string, options: EntryImageOptions): Promise<FetchedImage> {
  const result: CompressedImageResult = await getCompressedImage({
    url,
    maxWidth: options.maxImageWidth,
    quality: options.avifQuality,
    maxSourceBytes: options.maxSourceImageBytes,
  })
  if (!result.ok) return { ok: false, reason: result.reason }
  return { ok: true, buffer: result.buffer, width: result.width, height: result.height }
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

/**
 * 下载并压缩单张图片（feed 图标 / 头像等），返回附件数据与 CachedImage 元数据。
 * 失败返回 null（含缓存服务不可用）。
 *
 * 去重交给内容寻址缓存（同 URL + 同参数全局只压一次，见 images/cache.ts 的 inflight 表），
 * 这里不再自己维护进程内 Map —— 那份 Map 只活在一个进程里，多实例部署时并不共享。
 */
export async function cacheSingleImage(url: string): Promise<{ image: CachedImage, data: Buffer } | null> {
  const result = await getCompressedImage({ url, maxWidth: FEED_ICON_MAX_WIDTH })
  if (!result.ok) return null
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
    const fetched = await fetchCompressed(protocolCoverUrl, options)
    if (!fetched.ok) {
      bump(fetched.reason)
    } else {
      const name = `img-${images.length}.avif`
      attachments.push({ name, data: fetched.buffer, content_type: "image/avif" })
      images.push({
        url: protocolCoverUrl, attachment: name,
        width: fetched.width, height: fetched.height,
        cover: true,
      })
      budgetUsed += fetched.buffer.length
    }
  }

  // 分批并发下载+压缩，批间按正文顺序累计体积，超预算即停止后续批次。
  //
  // 为什么分批而不是继续一把并发：预算只有压缩完才知道大小，必须先算完一批才能决定
  // 下一批还要不要下。批大小取 DOWNLOAD_CONCURRENCY，最坏浪费一批的带宽/CPU。
  // 结果按正文出现顺序收集（并发完成顺序不定，封面选择依赖稳定顺序）。
  type BatchOutcome = FetchedImage & { url: string }
  const results: Array<{ url: string, result: { buffer: Buffer, width: number, height: number } } | null> =
    new Array(urls.length).fill(null)
  let budgetExhausted = false
  for (let start = 0; start < urls.length && !budgetExhausted; start += DOWNLOAD_CONCURRENCY) {
    const batch = urls.slice(start, start + DOWNLOAD_CONCURRENCY)
    const outcomes = await Promise.all(batch.map(async (url): Promise<BatchOutcome | null> => {
      // 协议封面已在上面缓存，正文里重复的 URL 跳过
      if (url === protocolCoverUrl) return null
      return { url, ...await fetchCompressed(url, options) }
    }))
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k]
      if (!o) continue
      if (!o.ok) {
        bump(o.reason)
        continue
      }
      const size = o.buffer.length
      // 首图必留：budgetUsed 为 0 时（无协议封面且这是第一张）即使超预算也存
      if (budgetUsed > 0 && budgetUsed + size > budget) {
        budgetExhausted = true
        skippedByBudget = urls.length - (start + k)
        break
      }
      budgetUsed += size
      results[start + k] = { url: o.url, result: { buffer: o.buffer, width: o.width, height: o.height } }
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
