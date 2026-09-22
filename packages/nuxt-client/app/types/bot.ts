/**
 * Bot 相关的前端类型。
 *
 * 后端这些接口返回的是 Drizzle 行（字段比这里多），前端只声明真正读取的字段；
 * 页面与 useApi 共用同一份定义，避免每个页面各写一个 interface 后互相漂移。
 */

/** Bot 元数据（我的 Bot 列表 / Bot 详情共用） */
export interface BotInfo {
  id: string
  name: string
  preferredUsername: string
  description?: string
  avatarUrl?: string
  isActive: boolean
}

/** 公开 Bot（广场页）：结构与 BotInfo 相同，语义上区分「所有人可见」 */
export type PublicBot = BotInfo

/** Bot 已关联的订阅源（join feeds 表带出标题与 URL） */
export interface AttachedFeed {
  feedId: string
  title: string
  url?: string
}

/** Bot 关注的远端账号 */
export interface FollowingItem {
  id: string
  handle: string
  actorName?: string
  actorAvatar?: string
  status: 'pending' | 'accepted' | 'rejected'
}

/** Bot 视角时间线里的一条动态 */
export interface TimelineItem {
  id: string
  actorId: string
  actorName?: string
  actorAvatar?: string
  content: string
  url?: string
  publishedAt: string
}

/** 创建 Bot 的请求体 */
export interface BotCreateBody {
  name: string
  preferredUsername: string
  description?: string
  avatarUrl?: string
}

/** 更新 Bot 的请求体（目前页面只用 isActive 做启用/停用） */
export interface BotUpdateBody {
  isActive?: boolean
  name?: string
  description?: string
  avatarUrl?: string
}
