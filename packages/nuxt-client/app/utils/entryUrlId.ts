/**
 * 条目地址里的 id ↔ 本地集中库的文档 id。
 *
 * 集中库里的条目 id 形如 `entry:<feedId>:<hash12>`（hash 由 guid 的 sha256 取前 12 位，
 * 见 hono-server 的 workers），而详情地址本身已经带着源 id（`/rss/feed/:feedId/entry/:entryId`），
 * 段里再写一遍 `entry:<feedId>:` 只是噪音。所以地址里只留最后那段 hash，
 * 取文档时再把前缀拼回去 —— 这一步必须是可逆的纯函数，不能靠「查一遍库看看哪个 id 对得上」。
 */

/** 条目文档 id 的固定前缀：`entry:<feedId>:` */
function prefixOf(feedId: string): string {
  return `entry:${feedId}:`
}

/**
 * 集中库条目 id → 地址里的那一段。
 *
 * 不符合本格式的 id（别的来源 / 历史数据）原样返回：宁可地址难看一点，也不能把 id 截错，
 * 否则详情就打不开了。
 */
export function toEntryUrlId(entryId: string, feedId: string): string {
  const prefix = prefixOf(feedId)
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId
}

/**
 * 地址里的那一段 → 集中库文档 id。
 *
 * 段里已经带 `:` 时按完整的文档 id 处理：一来旧地址（段里带 `entry:<feedId>:` 前缀）仍然打得开，
 * 二来不会拼出 `entry:<feedId>:entry:...` 这种不存在的 id。
 */
export function toEntryDocId(urlId: string, feedId: string): string {
  return urlId.includes(':') ? urlId : prefixOf(feedId) + urlId
}
