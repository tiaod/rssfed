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
export const COUCHDB_BOT_PREFIX = "bot_"
/**
 * 每用户的时间线库前缀：服务端按用户订阅聚合出的**派生**库，浏览器只需要同步它。
 *
 * 与 user-state 库同规格（随机后缀 + 库名回写业务列）：同样是「一个用户一个库」，
 * 只是内容从「用户自己的操作状态」换成「服务端替他聚合好的条目」。
 */
export const COUCHDB_USER_TIMELINE_PREFIX = "user-timeline_"
export const CLEANUP_DAYS = 30