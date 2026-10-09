export enum FeedViewType {
  All = 0,
  Articles = 1,
  SocialMedia = 2,
  Pictures = 3,
  Videos = 4,
  Audios = 5,
  Notifications = 6,
}

// CouchDB 库名仅允许小写字母/数字及 _ $ ( ) + - /，冒号非法
// 前缀与随机部分用下划线分隔，避免与前缀内部的连字符混淆（user-timeline_xxx / feed_xxx）
export const COUCHDB_FEED_PREFIX = "feed_"
export const COUCHDB_BOT_PREFIX = "bot_"
/**
 * 每用户的库前缀：一个用户一个库，里面既有服务端按订阅聚合出的条目，
 * 也有用户自己的订阅与已读收藏（浏览器同步的就是它）。
 *
 * 历史上「用户状态」与「聚合条目」是两个库（`user-state_` / `user-timeline_`），
 * 合并的原因与写方向边界见 couchdb/client.ts 的 TIMELINE_DESIGN_DOC。
 */
export const COUCHDB_USER_TIMELINE_PREFIX = "user-timeline_"
export const CLEANUP_DAYS = 30