import type { FeedViewType } from "./constants"

export interface FeedDoc {
  _id: string
  _rev?: string
  type: "feed"
  url: string
  title: string
  description?: string
  siteUrl?: string
  image?: string
  /** feed 图标缓存（AVIF 附件 feed-image.avif），供前端离线展示 */
  imageCached?: CachedImage
  /**
   * @deprecated 抓取簿记已移回 PostgreSQL `feeds` 表（不写 FeedDoc）。
   * 旧文档里可能还带着；下一次展示字段变化时会随重写清掉（见 workers/feed-doc.ts）。
   */
  errorMessage?: string
  /** @deprecated 同上：最后抓取时间以 `feeds.last_fetched_at` 为准 */
  lastFetchedAt?: string
  createdAt: string
}

export interface EntryDoc {
  _id: string
  _rev?: string
  type: "entry"
  feedId: string
  url: string
  title: string
  content?: string
  description?: string
  guid: string
  author?: string
  authorUrl?: string
  authorAvatar?: string
  publishedAt: string
  insertedAt: string
  categories?: string[]
  media?: MediaModel[]
  attachments?: AttachmentModel[]
  /** 缓存到 entry 附件的正文图片（AVIF），供前端离线直接展示 */
  images?: CachedImage[]
}

/** 缓存到 entry attachment 的正文图片 */
export interface CachedImage {
  /** 原始图片 URL（解析为绝对地址，前端据此匹配 <img src>） */
  url: string
  /** CouchDB attachment 名（如 img-0.avif） */
  attachment: string
  /** 压缩后尺寸（前端可作占位） */
  width?: number
  height?: number
  /**
   * 占位图的 BlurHash（极低频缩略，几十字节）。
   *
   * 前端在正文图换成本地附件 blob **之前**先用它当占位（见 nuxt-client 的
   * utils/blurhash.ts 与 composables/useEntryContent.ts）：换 src 必须发生在 HTML 注入之前，
   * 而附件字节只能异步读，所以插入时手里能有的只有这个字符串。
   * 没有该字段（老条目 / 编码失败）时前端退化为 1×1 透明占位。
   */
  blurhash?: string
  /** 是否为封面图（正文中面积最大的一张，列表缩略图用） */
  cover?: boolean
  /**
   * 压缩参数版本（目前只有 feed 图标用）。
   * 改图标的目标尺寸/质量时必须递增，否则老 feed 文档不会重新压缩 ——
   * 详见 entry-images.ts 的 FEED_ICON_CACHE_VERSION。
   */
  v?: number
}

export interface UserEntryDoc extends EntryDoc {
  read: boolean
  readAt?: string
  saved: boolean
}

export interface MediaModel {
  url: string
  type: string
  width?: number
  height?: number
}

export interface AttachmentModel {
  url: string
  mimeType: string
  title?: string
}

export interface SubscriptionDoc {
  _id: string
  _rev?: string
  type: "subscription"
  feedId: string
  category?: string
  /** 从 FeedDoc 反范式的字段，方便离线展示 */
  title: string
  siteUrl?: string
  description?: string
  image?: string
  createdAt: string
}

/** 用户对单条条目的操作状态，存放在 user-state 库中 */
export interface EntryStateDoc {
  _id: string
  _rev?: string
  type: "entry-state"
  entryId: string
  feedId: string
  read: boolean
  readAt?: string
  saved: boolean
  savedAt?: string
}

export interface BotConfig {
  id: string
  name: string
  description?: string
  preferredUsername: string
  avatarUrl?: string
  isActive: boolean
  feedIds: string[]
}

export interface SyncRequest {
  feedIds: string[]
}

export interface SyncResponse {
  status: "syncing" | "completed"
  syncedCount: number
  totalCount: number
}