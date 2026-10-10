/**
 * CouchDB 文档 id 的取值规则。
 *
 * FeedDoc（源元数据文档，存在该源自己的 `feed_*` 库里）此前直接用 `feedId` 当 `_id`。
 * 但 feedId 由 `sha256(url).base64url.slice(0, 16)` 派生，base64url 字母表含 `_`，
 * 于是约 1/64 的源 feedId 以 `_` 开头（现网 707 个源里有 9 个），而 CouchDB 保留
 * `_` 开头的文档 id：
 *
 *     Error: Only reserved document ids may start with underscore.
 *
 * 这类源的库建出来了、设计文档也装了，但 FeedDoc 永远写不进去（库里只剩 `_design/main`），
 * 表现为「订阅在、队列在跑、条目库一直空」，而且错误只落在那次 job 上，很容易漏看。
 *
 * 所以这里统一给这类 id 加 `feed` 前缀：加前缀后长度 20，与未加前缀的 id（12/16 位）不可能撞车，
 * 以 `_` 开头的文档 id 也归零；存量文档（id 不以 `_` 开头）完全不受影响，因此不需要迁移。
 *
 * 前端 `packages/nuxt-client/app/utils/feedDocId.ts` 有一份同样的实现（读 FeedDoc 时要用同样的
 * 规则），改动时两处必须同步。
 */
export function feedDocId(feedId: string): string {
  return feedId.startsWith("_") ? `feed${feedId}` : feedId
}
