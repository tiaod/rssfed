/**
 * 列表条目的展示派生值：各视图（瀑布流 / 博客 / 列表 / 表格 / 图片）共用同一套口径。
 *
 * 纯函数、无 Nuxt / 浏览器依赖，方便单测；组件只负责把它们摆进各自的版式。
 */

import type { RssEntry } from '~/types/rss'

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
 * 封面的宽高比 = width / height（拿不到返回 null）。
 *
 * 列表查询的 images 投影带着压缩后的尺寸，所以图片瀑布流能在图片加载前就按真实比例占位：
 * 高度估算 / 泳道分配 / 首帧布局都不用等图片解码完成（官方 masonry 例子给的是常数估算，
 * 我们这里能按每张图算准，列尾参差更小）。
 */
export function entryCoverAspect(entry: Pick<RssEntry, 'images' | 'coverUrl'>): number | null {
  // 只有真能渲染出封面（enrichEntries 已解析出 blob URL）时才有意义
  if (!entry.coverUrl) return null
  const cover = entry.images?.find(item => item.cover)
  if (!cover?.width || !cover?.height) return null
  return cover.width / cover.height
}
