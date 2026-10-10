/**
 * 读取 FeedDoc（源元数据文档）时用的文档 id。
 *
 * 与后端 `packages/hono-server/src/couchdb/doc-ids.ts` 保持一致：feedId 由
 * `sha256(url).base64url` 派生，可能以 `_` 开头（如 `_2lv5T_YCYekFKFn`），而 CouchDB 保留
 * `_` 开头的文档 id，所以后端给这类 id 加了 `feed` 前缀。前端按 id 读 FeedDoc（源名/图标）
 * 时必须用同一规则，否则这类源在本地库里永远查不到元信息。
 *
 * 改动时两处必须同步。
 */
export function feedDocId(feedId: string): string {
  return feedId.startsWith('_') ? `feed${feedId}` : feedId
}
