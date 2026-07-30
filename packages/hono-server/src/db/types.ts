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