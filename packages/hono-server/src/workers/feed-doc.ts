import type { ParsedFeed } from "../rss/parser"

/**
 * CouchDB FeedDoc（源元信息文档）的写入规则。
 *
 * ## 这份文档为什么特殊
 *
 * FeedDoc 存在源库 `feed_*` 里，但它**会被 CouchDB 复制器原样搬进每个订阅者的用户聚合库**
 * （`user-timeline_*`），再经 live pull 同步到每个浏览器。也就是说：FeedDoc 每多一个修订，
 * 就是「每个订阅者各写一版 + 每个在线客户端收一次变更」。
 *
 * 所以它只该装**客户端离线渲染需要、且很少变化**的展示字段：
 * title / description / siteUrl / image（外加图标附件 `imageCached`）。
 *
 * 抓取簿记（ETag / Last-Modified / 验证器来源 URL / 最后抓取时间 / 错误信息）**不能放这里**：
 *   - 它们每轮抓取都可能变，客户端一个都不读（权威在 PostgreSQL `feeds` 表）；
 *   - 早期实现每轮 200 都重写一遍 FeedDoc，实测单源累计上千个修订、一个 129 订阅的账号
 *     11.4 万版（~90MB 死空间），并且这些修订会一版版复制进用户库。
 *
 * 现在：`shouldWriteFeedDoc` 只在展示字段真的变化时返回 true，`buildFeedDoc` 构造出的文档
 * 还会顺手清掉旧版遗留的簿记字段（存量文档下一次写入时完成一次性迁移）。
 */

/** FeedDoc 里允许存在的展示字段（`url` 是源地址，创建后一般不变） */
export interface FeedDocDisplay {
  title: string
  description?: string
  siteUrl?: string
  image?: string
  url: string
}

/**
 * 旧版 FeedDoc 里混进来的抓取簿记字段。
 *
 * 不迁移存量文档：下一次该源抓取成功、展示字段有变化（或这些键还在）时会重写一次，
 * 自然把它们清掉。`shouldWriteFeedDoc` 把「还带着遗留簿记」也当成需要重写的条件，
 * 保证每个源在升级后至少被清理一次，不会永远留在库里。
 */
const LEGACY_FETCH_BOOKKEEPING = [
  "lastFetchedAt",
  "errorMessage",
  "fetchEtag",
  "fetchLastModified",
  "fetchValidatorUrl",
] as const

/** 从解析结果合并出下一次的展示字段；解析不到的字段沿用旧值 */
export function mergeFeedDocDisplay(
  existing: Record<string, any> | null | undefined,
  parsed: ParsedFeed,
  feedUrl: string,
): FeedDocDisplay {
  return {
    // 标题为空串时也回退（部分源会给出空 <title>）
    title: parsed.title || existing?.title || feedUrl,
    description: parsed.description ?? existing?.description,
    siteUrl: parsed.link ?? existing?.siteUrl,
    image: parsed.image?.url ?? existing?.image,
    url: existing?.url ?? feedUrl,
  }
}

/**
 * 展示字段真的变了吗？
 *
 * 与 `shouldWriteFeedDoc` 分开是因为两者用途不同：清理遗留簿记也要写文档，但**不该**
 * 触发一次用户库同步（那只是把旧字段抹掉，客户端看不到任何变化）。只有展示字段变了
 * 才需要 bump `feeds.last_changed_at` 去让镜像跟着更新。
 */
export function feedDocDisplayChanged(
  existing: Record<string, any> | null | undefined,
  next: FeedDocDisplay,
): boolean {
  if (!existing) return true
  return existing.title !== next.title
    || existing.description !== next.description
    || existing.siteUrl !== next.siteUrl
    || existing.image !== next.image
}

/** 该 FeedDoc 现在需要重写吗？（展示字段没变、也没遗留簿记 → 不写，避免产生无意义修订） */
export function shouldWriteFeedDoc(
  existing: Record<string, any> | null | undefined,
  next: FeedDocDisplay,
): boolean {
  if (!existing) return true
  // 存量文档还带着旧版簿记：写一次把它们清掉（一次性迁移）
  if (LEGACY_FETCH_BOOKKEEPING.some((key) => key in existing)) return true
  return feedDocDisplayChanged(existing, next)
}

/**
 * 图标附件需要重做吗？（URL 变了、没有缓存、或压缩参数版本升级）
 *
 * 版本判断不能省：附件名固定为 `feed-image.avif`，光比 URL 发现不了参数变化。
 * 版本号由调用方传入（`FEED_ICON_CACHE_VERSION`），保持这个模块不依赖图片管线。
 */
export function shouldCacheFeedIcon(
  existing: Record<string, any> | null | undefined,
  imageUrl: string | undefined,
  cacheVersion: number,
): boolean {
  if (!imageUrl) return false
  const cached = existing?.imageCached
  return !cached || imageUrl !== cached.url || cached.v !== cacheVersion
}

/**
 * 构造要写回 CouchDB 的 FeedDoc。
 *
 * - 更新时保留 `_id` / `_rev` / `createdAt` / `imageCached` 与其它未知字段（只剔除遗留簿记）；
 * - 首次创建时补 `_id` / `type` / `createdAt`；
 * - `imageCached`（图标附件）由调用方在图标缓存成功时另行合并，不在这里判断。
 */
export function buildFeedDoc(
  existing: Record<string, any> | null | undefined,
  next: FeedDocDisplay,
  docId: string,
  nowIso: string,
): Record<string, any> {
  if (!existing) {
    return {
      _id: docId,
      type: "feed",
      ...next,
      createdAt: nowIso,
    }
  }
  const base: Record<string, any> = { ...existing }
  for (const key of LEGACY_FETCH_BOOKKEEPING) delete base[key]
  return { ...base, ...next }
}
