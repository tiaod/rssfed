/**
 * 本地 PouchDB 库名，一律按账号隔离。
 *
 * 旧版本用固定库名（rssfed-entries / rssfed-user-state），而用户状态库走的是
 * **双向**同步：同一浏览器换账号登录时，装着上一个账号数据的本地库会把数据
 * 推送到新账号的远端库 —— 那是数据串号，不只是「看到旧数据」。
 * 库名带上 userId 之后，各账号各用各的本地库，互不干扰（也各自保留离线数据）。
 *
 * 会话尚未就绪或未登录时落到 `guest`：这段时间写入的数据不会被任何账号继承。
 *
 * 服务端聚合改造后本地只剩两个库：
 *   - `rssfed-timeline-<userId>`：服务端聚合好的条目（**单向** live 复制下来，本地只读）
 *   - `rssfed-user-state-<userId>`：订阅关系与已读/收藏（双向同步）
 * 以前那几百个 per-feed 本地库已经不存在，旧库名走 cleanupLegacyDbs 清理。
 */

/** 本地库种类：时间线库（服务端聚合的派生库）/ 用户状态库 */
export type LocalDbKind = 'timeline' | 'user-state'

function dbSuffix(userId: string | null | undefined): string {
  return userId && userId.length > 0 ? userId : 'guest'
}

/** 本地 PouchDB 库名，如 rssfed-timeline-<userId> */
export function localDbName(kind: LocalDbKind, userId: string | null | undefined): string {
  return `rssfed-${kind}-${dbSuffix(userId)}`
}

/**
 * 会话内「上次催促服务端聚合」的时间戳（localStorage，按账号隔离）。
 *
 * 只用来给「进入页面时催一次服务端聚合」节流，语义上是**提示性的**：
 * 丢了最多多催一次，催了也只是一次入队请求（服务端的增量判断会立刻返回），
 * 所以不需要任何一致性保证。
 */
export function lastTimelineRefreshKey(userId: string | null | undefined): string {
  return `rssfed-timeline-refresh-${dbSuffix(userId)}`
}

/** 账号隔离之前使用的固定库名（升级时清理，见 usePouchDb 的 cleanupLegacyDbs） */
export const LEGACY_LOCAL_DB_NAMES = ['rssfed-entries', 'rssfed-user-state'] as const

/**
 * 需要清理的历史本地库前缀。
 *
 * - `rssfed-feed-`：per-feed 多库时代（每个订阅源一个本地库）
 * - `rssfed-entries`：集中条目库时代（含按账号隔离的 `rssfed-entries-<userId>`）
 *
 * 这两个时代的数据都由服务端聚合的时间线库重新拉取，且**结构已变**
 * （条目现在带按用户参数压缩的附件），所以一律丢弃而不是迁移。
 */
export const LEGACY_LOCAL_DB_PREFIXES = ['rssfed-feed-', 'rssfed-entries'] as const

/**
 * PouchDB 在 IndexedDB 里的**实际**库名带 `_pouch_` 前缀，视图库还多一个 `-mrview-<hash>` 后缀。
 *
 * `PouchDB.allDbs()` 返回的就是这种实际名字，而 `LEGACY_LOCAL_DB_PREFIXES` 是**逻辑**名。
 * 直接拿前缀去匹配实际名永远不命中 —— 旧条目库会一直躺在用户的浏览器里（实测
 * `_pouch_rssfed-entries-<userId>` 升级后仍在）。所以匹配前先剥掉 `_pouch_`。
 */
export function stripPouchNamePrefix(raw: string): string {
  return raw.startsWith('_pouch_') ? raw.slice('_pouch_'.length) : raw
}

/** 实际（IndexedDB）库名是否属于要清理的历史库；视图库后缀不影响判断 */
export function isLegacyLocalDbName(raw: string): boolean {
  const name = stripPouchNamePrefix(raw)
  return LEGACY_LOCAL_DB_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** 账号隔离之前用过的 localStorage 键前缀（旧版本会再拼一个 `-<userId>` 后缀） */
export const LEGACY_LOCAL_STORAGE_PREFIXES = [
  'rssfed-synced-feeds',
  'rssfed-sync-retry',
  'rssfed-sync-window'
] as const

/** 是否为要清理的历史 localStorage 键（含带账号后缀的形式） */
export function isLegacyLocalStorageKey(key: string): boolean {
  return LEGACY_LOCAL_STORAGE_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}-`))
}
