export interface RssFeed {
  id: string
  title: string
  siteUrl: string
  feedUrl: string
  description?: string
  image?: string
  errorMessage?: string
  category?: RssCategory
  lastFetchedAt: string
}

export interface RssEntry {
  id: string
  feedId: string
  title: string
  url: string
  content?: string
  description?: string
  author?: string
  publishedAt: string
  insertedAt: string
  categories?: string[]
  feed: RssFeed
  starred: boolean
  read: boolean
  readingTime: number
  enclosures?: RssEnclosure[]
  /** 已缓存为本地附件的正文图片（AVIF），渲染时替换 <img src> */
  images?: RssCachedImage[]
  /** 封面图 blob URL（images 中 cover 标记的一张，列表缩略图用；无则 undefined） */
  coverUrl?: string
}

/** 缓存到 entry 附件的正文图片（AVIF） */
export interface RssCachedImage {
  /** 原始图片 URL（解析为绝对地址，用于匹配 <img src>） */
  url: string
  /** PouchDB attachment 名（如 img-0.avif） */
  attachment: string
  /** 压缩后尺寸 */
  width?: number
  height?: number
  /** 是否为封面图（正文中面积最大的一张） */
  cover?: boolean
}

export interface RssEnclosure {
  url: string
  mimeType: string
  size: number
}

export interface RssCategory {
  id: string
  title: string
}

/** 订阅抓取状态：全部由注册表真实字段判定（status / errorMessage） */
export type FeedStatus = 'active' | 'paused' | 'error'

/** 管理员视角的订阅源注册表项（含 per-feed 图片缓存策略） */
export interface AdminFeed {
  id: string
  url: string
  title: string
  description?: string
  siteUrl?: string
  image?: string
  status: FeedStatus
  errorMessage?: string
  lastFetchedAt?: string
  createdAt: string
  // per-feed 图片缓存策略（见 rss/entry-images.ts）
  cacheImages: boolean
  maxImageCount: number | null
  maxImageWidth: number | null
  avifQuality: number | null
  maxSourceImageBytes: number | null
}

/** 订阅管理列表项：用户订阅信息 + 注册表抓取状态 */
export interface FeedSubscriptionItem {
  feedId: string
  title: string
  siteUrl?: string
  image?: string
  description?: string
  category?: string
  createdAt: string
  status: FeedStatus
  errorMessage?: string
  lastFetchedAt?: string
  /** 最后抓到新条目的时间：前端据此只同步「上次同步后有过新内容」的源 */
  lastNewEntryAt?: string
}
