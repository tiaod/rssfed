import { createCouchDb, ensureTimelineDatabase } from "../couchdb/client"
import { feedDocId } from "../couchdb/doc-ids"
import { getSubscribedFeedIds } from "./feeds"

/**
 * 读取内容/条目服务层（用户级），供 MCP 工具（get_feed / list_entries / search_entries）复用。
 *
 * **读的是该用户自己的库**：新模型下没有共享的 `feed_*` 库，用户库里的 `entry:*` 就是这个用户
 * 订阅到的全部内容（条目 + AVIF 附件 + FeedDoc 副本都在同一个库里）。
 *
 * 安全：所有读取都先校验该 feed 属当前用户订阅，只返回用户已订阅的源内容 ——
 * 用户库本身是按用户隔离的（`_security.members.names`），这道校验是纵深防御。
 */

/** 判断 feedId 是否属于当前用户订阅 */
async function assertSubscribed(userId: string, feedId: string): Promise<boolean> {
  const subscribed = await getSubscribedFeedIds(userId)
  return subscribed.has(feedId)
}

async function userScope(userId: string) {
  return createCouchDb(await ensureTimelineDatabase(userId))
}

/** 读取单个订阅源的元数据（FeedDoc）；非用户订阅返回 null */
export async function getFeed(userId: string, feedId: string) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const scope = await userScope(userId)
  try {
    return await scope.get(feedDocId(feedId))
  } catch {
    return null
  }
}

/**
 * 读取某源最新条目（裁剪字段，避免返回完整正文烧 token）；非用户订阅返回 null。
 *
 * 用 `by-feed-date` 视图（key = `[feedId, publishedAt]`）而不是 `entries-by-date`：
 * 用户库一个库里装着多个源，必须按源过滤才能分页 —— 以前每个源独立库时直接
 * `descending + skip/limit` 就够了，那是共享源库时代的前提。
 */
export async function listEntries(userId: string, feedId: string, limit = 20, offset = 0) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const scope = await userScope(userId)
  const safeLimit = Math.min(Math.max(1, limit), 100)
  const safeOffset = Math.max(0, offset)

  // 倒序（最新在前）+ skip/limit 分页：视图行序是 [feedId, publishedAt] 的全序，
  // descending 之后同一 feed 内的顺序正好是"新→旧"，skip 与 limit 都作用在这个顺序上。
  const result = await scope.view("main", "by-feed-date", {
    startkey: [feedId, {}],
    endkey: [feedId, ""],
    descending: true,
    limit: safeLimit,
    skip: safeOffset,
    include_docs: true,
  }) as unknown as { rows?: Array<{ doc?: Record<string, unknown> }> }

  const items = (result.rows ?? [])
    .map((row) => row.doc)
    .filter((doc): doc is Record<string, unknown> => Boolean(doc))
  return items.map((doc) => ({
    id: doc._id,
    title: doc.title,
    url: doc.url,
    publishedAt: doc.publishedAt,
    summary: doc.summary ?? doc.description ?? stripHtml(String(doc.content ?? "")).slice(0, 300),
    author: doc.author,
  }))
}

/** 在某源已抓取条目中按关键词搜索标题（简单过滤）；非用户订阅返回 null */
export async function searchEntries(userId: string, feedId: string, keyword: string, limit = 20) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const scope = await userScope(userId)
  const needle = keyword.trim().toLowerCase()
  const safeLimit = Math.min(Math.max(1, limit), 100)

  // 先在库里按 feedId 过滤出候选，再在内存中对标题/摘要做包含匹配：
  // 用户库的 Mango 索引只建在 type 上，`feedId` 上的 find 会退化成全库扫描。
  // 用 by-feed-date 视图拿到该源的条目（最多 N 条，N ≤ 50）再过滤更划算。
  const result = await scope.view("main", "by-feed-date", {
    startkey: [feedId, {}],
    endkey: [feedId, ""],
    descending: true,
    limit: 1_000,
    include_docs: true,
  }) as unknown as { rows?: Array<{ doc?: Record<string, unknown> }> }

  const docs = (result.rows ?? [])
    .map((row) => row.doc)
    .filter((doc): doc is Record<string, unknown> => Boolean(doc))

  const hits = docs.filter((doc) => {
    const hay = `${doc.title ?? ""} ${doc.summary ?? ""} ${doc.description ?? ""} ${stripHtml(String(doc.content ?? "")).slice(0, 500)}`.toLowerCase()
    return hay.includes(needle)
  })
  return hits.slice(0, safeLimit).map((doc) => ({
    id: doc._id,
    title: doc.title,
    url: doc.url,
    publishedAt: doc.publishedAt,
    summary: doc.summary ?? doc.description ?? stripHtml(String(doc.content ?? "")).slice(0, 300),
    author: doc.author,
  }))
}

/** 去除 HTML 标签，返回纯文本 */
function stripHtml(html: string): string {
  return html
    ?.replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .trim() ?? ""
}
