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
  errorMessage?: string
  lastFetchedAt: string
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
  /** 是否为封面图（正文中面积最大的一张，列表缩略图用） */
  cover?: boolean
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