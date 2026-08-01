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
// 前缀与随机部分用下划线分隔，避免与前缀内部的连字符混淆（user-state_xxx / feed_xxx）
export const COUCHDB_FEED_PREFIX = "feed_"
export const COUCHDB_USER_STATE_PREFIX = "user-state_"
export const CLEANUP_DAYS = 30