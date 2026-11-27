// CouchDB 库名仅允许小写字母/数字及 _ $ ( ) + - /，冒号非法
// 前缀与随机部分用下划线分隔，避免与前缀内部的连字符混淆（user-timeline_xxx / bot_xxx）
//
// 旧模型的共享源库前缀 `feed_` 已不存在：那一批库由 `scripts/reset-to-owner-model.ts`
// 整体删除，抓取改为按 owner 直接写各自的库。该脚本自己持有 `feed_` 字面量用于清理存量。
export const COUCHDB_BOT_PREFIX = "bot_"
/**
 * 每用户的库前缀：一个用户一个库，里面既有服务端按订阅聚合出的条目，
 * 也有用户自己的订阅与已读收藏（浏览器同步的就是它）。
 *
 * 历史上「用户状态」与「聚合条目」是两个库（`user-state_` / `user-timeline_`），
 * 合并的原因与写方向边界见 couchdb/client.ts 的 TIMELINE_DESIGN_DOC。
 */
export const COUCHDB_USER_TIMELINE_PREFIX = "user-timeline_"
