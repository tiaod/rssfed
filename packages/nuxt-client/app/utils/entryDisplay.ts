/**
 * 列表条目的展示派生值：各视图（瀑布流 / 博客 / 列表 / 表格 / 图片）共用同一套口径。
 *
 * 纯函数、无 Nuxt / 浏览器依赖，方便单测；组件只负责把它们摆进各自的版式。
 */

import type { RssCachedImage, RssEntry } from '~/types/rss'

/**
 * 摘要文本。
 *
 * 列表查询（utils/localViews.ts 的视图投影）裁剪了 content（全文）字段，
 * 所以优先用 description（列表查询仍包含），content 只作兜底。
 */
export function entryExcerpt(
  entry: Pick<RssEntry, 'description' | 'content'>,
  maxLength = 150
): string {
  const text = (entry.description || entry.content || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text
}

/**
 * 封面图配置。
 *
 * 封面是本地缓存的 AVIF blob，`loading` / `decoding` 会透传到 `<img>`（UBlogPost 对 image
 * 对象是整份 v-bind 展开）：`decoding="async"` 让解码不占主线程——滚动时封面进视口那一下
 * 最容易掉帧；`loading="lazy"` 让视口外的封面延后加载。
 */
export function entryCoverImage(entry: Pick<RssEntry, 'coverUrl' | 'title'>) {
  return entry.coverUrl
    ? {
        src: entry.coverUrl,
        alt: entry.title,
        loading: 'lazy' as const,
        decoding: 'async' as const
      }
    : undefined
}

/** 署名用的订阅源名（feed 元信息由 enrichEntries 补全，缺失时兜底） */
export function entryFeedName(entry: Pick<RssEntry, 'feed'>): string {
  return entry.feed?.title || '未知来源'
}

/**
 * 署名文本：聚合视图署「所属订阅源」，单源页署「条目作者」（源已经写在页面标题里，
 * 作者名更有信息量）。列表行、表格行、社交动态的作者行共用这一份口径，不再各写一遍三元表达式。
 */
export function entryByline(
  entry: Pick<RssEntry, 'feed' | 'author'>,
  showFeed?: boolean
): string {
  return showFeed ? entryFeedName(entry) : (entry.author || entryFeedName(entry))
}

/**
 * 条目日期文本（zh-CN 数字格式），省略年份以外的精度。
 *
 * 列表视图与表格视图都要在行里显示日期，口径抽在这里 —— 同一个 publishedAt 在两处
 * 显示成两种样子会让人以为数据不同。解析失败（字段缺失 / 非法时间）返回空串，
 * 由调用方决定是省略这一段还是留空。
 */
export function entryDate(entry: Pick<RssEntry, 'publishedAt'>): string {
  const time = new Date(entry.publishedAt)
  return Number.isNaN(time.getTime())
    ? ''
    : time.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/** 没有封面、或封面元信息缺失时的兜底宽高比（4:3 横图，见 entryCoverAspect） */
export const IMAGE_TILE_FALLBACK_ASPECT = 4 / 3

/**
 * 相对时间（社交动态的作者行用）：刚刚 / N 分钟前 / N 小时前 / N 天前，超过一周回到绝对日期。
 *
 * 只给一个「多新」的观感，精确值由调用方放进 `<time>` 的 title（见 EntrySocialItem）；
 * `now` 显式传入是为了单测能钉住边界，默认取调用那一刻。
 * 解析失败返回空串（与 entryDate 同口径）；未来时间（时钟偏差、定时发布的源）按「刚刚」处理。
 */
export function entryRelativeTime(
  entry: Pick<RssEntry, 'publishedAt'>,
  now: number = Date.now()
): string {
  const time = new Date(entry.publishedAt).getTime()
  if (Number.isNaN(time)) return ''

  const diff = now - time
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚' // 含未来时间（diff 为负）
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return entryDate(entry)
}

/**
 * 封面的宽高比 = width / height（拿不到返回 null）。
 *
 * 列表查询的 images 投影带着压缩后的尺寸，所以图片瀑布流能在图片加载前就按真实比例占位：
 * 高度估算 / 泳道分配 / 首帧布局都不用等图片解码完成（官方 masonry 例子给的是常数估算，
 * 我们这里能按每张图算准，列尾参差更小）。
 */
export function entryCoverAspect(entry: Pick<RssEntry, 'images' | 'coverUrl'>): number | null {
  // 只有真能渲染出封面（enrichEntries 已解析出 blob URL）时才有意义
  if (!entry.coverUrl) return null
  return imageAspect(entry.images?.find(item => item.cover))
}

/** 缓存图片的宽高比 = width / height（拿不到尺寸返回 null） */
export function imageAspect(
  image: Pick<RssCachedImage, 'width' | 'height'> | undefined
): number | null {
  if (!image?.width || !image?.height) return null
  return image.width / image.height
}

// ── 社交动态的图片区（1 张按原比例，2~6 张铺成相册网格） ──

/** 信息流内容列宽上限：与 EntrySocialItem 的 `max-w-xl` 同源（估算要用） */
export const FEED_COLUMN_MAX = 576
/**
 * 头像占掉的左侧一栏：头像 md(32) + 与正文的 gap-2(8)。署名 / 正文 / 图片 / 操作栏整块从它右边
 * 开始（对齐 X 那种版式），所以**图片区的可用宽度是列宽减去它**，估算图高要用这个值。
 */
export const FEED_CONTENT_INDENT = 40
/** 单图的高度上限：与组件里的 `max-h-[28rem]` 同源（估算要用） */
export const FEED_SINGLE_MAX_HEIGHT = 448
/** 一条动态最多铺几张图：再多一条就占掉整屏，后面的只看详情 */
export const FEED_MAX_IMAGES = 6
/** 图片格间距：与组件里的 `gap-1.5` 同源（估算要用） */
export const FEED_IMAGE_GAP = 6
/** 单图比例的下限（比这更长的长图）与上限（比这更宽的横幅）：超出的部分裁掉 */
export const FEED_SINGLE_MIN_ASPECT = 0.7
export const FEED_SINGLE_MAX_ASPECT = 2.4
/** 单图拿不到尺寸时的兜底比例（4:3 横图，与 IMAGE_TILE_FALLBACK_ASPECT 同口径） */
export const FEED_SINGLE_FALLBACK_ASPECT = 4 / 3

/**
 * 信息流里真画得出来的图：有本地附件才算（列表投影里的 images 就是已缓存的那批），
 * 最多 `FEED_MAX_IMAGES` 张。
 */
export function entryFeedImages(entry: Pick<RssEntry, 'images'>): RssCachedImage[] {
  return (entry.images ?? [])
    .filter(image => Boolean(image.attachment))
    .slice(0, FEED_MAX_IMAGES)
}

/**
 * 单图的展示比例：真实比例收进 [0.7, 2.4]。
 *
 * 只展示一张时给的是「原比例 + 限高限宽」——长图（竖屏截图那种）与超宽横幅按原比例上屏会
 * 要么占满几屏、要么压成一条细线，所以把比例夹进这个区间，超出的部分由 `object-cover` 裁掉；
 * 手机端的窄列下，宽高比本身也让图片按列宽缩下来。
 */
export function feedSingleAspect(
  image: Pick<RssCachedImage, 'width' | 'height'> | undefined
): number {
  const real = imageAspect(image) ?? FEED_SINGLE_FALLBACK_ASPECT
  return Math.min(FEED_SINGLE_MAX_ASPECT, Math.max(FEED_SINGLE_MIN_ASPECT, real))
}

/**
 * 相册网格里第 index 格的栅格跨度与宽高比。
 *
 * 版式照搬即刻 / 朋友圈那种九宫格：3 列（栅格 6 列，一格跨 2 列），整行 3 张都是正方形；
 * **最后一行不足 3 张时把这一行横向拉满**（1 张跨满 6 列 → 3:1，2 张各跨 3 列 → 3:2），
 * 于是每行高度一致（都是列宽的 1/3），行与行之间不会参差。空的地方不补位（不留白格）。
 */
export function feedImageCell(index: number, total: number): { span: number, aspect: number } {
  const lastRow = total % 3 === 0 ? 3 : total % 3
  if (index < total - lastRow) return { span: 2, aspect: 1 }
  return { span: 6 / lastRow, aspect: 3 / lastRow }
}

/**
 * 图片区的估算高度（列宽已知）。
 *
 * 单列信息流用它算总高度；估不准只牵连滚动条（没有泳道要对齐）。多图时每行高度=列宽的 1/3
 * （见 feedImageCell），所以 row 数一乘就是；单图按夹好的比例与高度上限算。
 */
export function feedImagesHeight(
  images: Pick<RssCachedImage, 'width' | 'height'>[],
  column: number
): number {
  if (images.length === 0) return 0
  if (images.length === 1) {
    return Math.min(FEED_SINGLE_MAX_HEIGHT, Math.round(column / feedSingleAspect(images[0])))
  }
  const rows = Math.ceil(images.length / 3)
  const rowHeight = (column - 2 * FEED_IMAGE_GAP) / 3
  return Math.round(rows * rowHeight + (rows - 1) * FEED_IMAGE_GAP)
}
