/**
 * CouchDB 文档 id 的取值规则。
 *
 * feedId 派生自 URL 的 base64url，约 1/64 含前导 `_`，而 CouchDB 保留 `_` 开头的文档 id ——
 * 这类源的 FeedDoc 会永远写不进去（现象与排查见 `docs/troubleshooting.md` 的
 * 「约 1/64 的源『订阅在、队列在跑、条目库一直空』」）。
 *
 * 所以给它们加 `feed` 前缀：加完长度 20，与未加前缀的 12/16 位不可能撞车；不以 `_` 开头的
 * 原样返回，存量文档不受影响，因此不需要迁移。
 *
 * 前端 `packages/nuxt-client/app/utils/feedDocId.ts` 有一份同样的实现，改动时两处必须同步。
 */
export function feedDocId(feedId: string): string {
  return feedId.startsWith("_") ? `feed${feedId}` : feedId
}
