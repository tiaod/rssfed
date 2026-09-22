/**
 * 本地 PouchDB 库名与增量同步记录的 key，一律按账号隔离。
 *
 * 旧版本用固定库名（rssfed-entries / rssfed-user-state），而用户状态库走的是
 * **双向**同步：同一浏览器换账号登录时，装着上一个账号数据的本地库会把数据
 * 推送到新账号的远端库 —— 那是数据串号，不只是「看到旧数据」。
 * 库名带上 userId 之后，各账号各用各的本地库，互不干扰（也各自保留离线数据）。
 *
 * 会话尚未就绪或未登录时落到 `guest`：这段时间写入的数据不会被任何账号继承。
 */

/** 本地库种类：集中条目库 / 用户状态库 */
export type LocalDbKind = 'entries' | 'user-state'

function dbSuffix(userId: string | null | undefined): string {
  return userId && userId.length > 0 ? userId : 'guest'
}

/** 本地 PouchDB 库名，如 rssfed-entries-<userId> */
export function localDbName(kind: LocalDbKind, userId: string | null | undefined): string {
  return `rssfed-${kind}-${dbSuffix(userId)}`
}

/** 增量同步记录（localStorage）的 key；不分账号的话，A 的同步记录会让 B 跳过同步 */
export function syncedFeedsKey(userId: string | null | undefined): string {
  return `rssfed-synced-feeds-${dbSuffix(userId)}`
}

/** 账号隔离之前使用的固定库名（升级时清理，见 usePouchDb 的 cleanupLegacyDbs） */
export const LEGACY_LOCAL_DB_NAMES = ['rssfed-entries', 'rssfed-user-state'] as const
