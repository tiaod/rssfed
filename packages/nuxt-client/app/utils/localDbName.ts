/**
 * 本地 PouchDB 库名，一律按账号隔离。
 *
 * 旧版本用固定库名（rssfed-entries / rssfed-user-state），而状态文档走的是
 * **双向**同步：同一浏览器换账号登录时，装着上一个账号数据的本地库会把数据
 * 推送到新账号的远端库 —— 那是数据串号，不只是「看到旧数据」。
 * 库名带上 userId 之后，各账号各用各的本地库，互不干扰（也各自保留离线数据）。
 *
 * 会话尚未就绪或未登录时落到 `guest`：这段时间写入的数据不会被任何账号继承。
 *
 * 服务端聚合 + 单库方案下本地也只有**一个**库：远端那一个库（条目 + 源元信息 +
 * 订阅/已读收藏）整份同步下来，条目只读、状态可写。
 *
 * 名字沿用 `rssfed-timeline-<userId>` 而不是改成 `rssfed-user-*`：改名等于换库，
 * 老用户本地上万条带附件的条目要整份重下，没有收益。以前那些库（per-feed 的
 * `rssfed-feed-*`、集中库 `rssfed-entries*`、状态库 `rssfed-user-state-*`）
 * 都由 cleanupLegacyDbs 清理。
 */

function dbSuffix(userId: string | null | undefined): string {
  return userId && userId.length > 0 ? userId : 'guest'
}

/** 本地 PouchDB 库名，如 rssfed-timeline-<userId>（每账号一个，装整个用户库） */
export function localDbName(userId: string | null | undefined): string {
  return `rssfed-timeline-${dbSuffix(userId)}`
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
 * - `rssfed-user-state`：用户状态单开一个本地库的时代（含 `-<userId>`）；合并成单库后
 *   状态文档从同一个远端库同步下来，本地那份已无用，留着只是白占空间
 *
 * 这些时代的数据都由服务端的用户库重新拉取，且**结构已变**
 * （条目现在带 AVIF 附件、字段也变过），所以一律丢弃而不是迁移。
 */
export const LEGACY_LOCAL_DB_PREFIXES = ['rssfed-feed-', 'rssfed-entries', 'rssfed-user-state'] as const

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
