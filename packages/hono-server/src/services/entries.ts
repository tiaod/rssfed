import { createCouchDb, ensureFeedDatabase } from "../couchdb/client"
import { getSubscribedFeedIds } from "./feeds"

/**
 * 读取内容/条目服务层（用户级）。
 *
 * 每个 feed 有独立的 CouchDB 库（feed:{feedId}），内含 feed 文档 + 若干 entry 文档，
 * 并安装 `entries-by-date` 设计文档视图。这里封装读取，供 MCP 工具（get_feed /
 * list_entries / search_entries）复用。
 *
 * 安全：所有读取都先校验该 feed 属当前用户订阅，只返回用户已订阅的源内容。
 */

/** 判断 feedId 是否属于当前用户订阅 */
async function assertSubscribed(userId: string, feedId: string): Promise<boolean> {
  const subscribed = await getSubscribedFeedIds(userId)
  return subscribed.has(feedId)
}

/** 读取单个订阅源的元数据（FeedDoc）；非用户订阅返回 null */
export async function getFeed(userId: string, feedId: string) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  try {
    const feed = await feedDb.get(feedId)
    return feed
  } catch {
    return null
  }
}

/** 读取某源最新条目（裁剪字段，避免返回完整正文烧 token）；非用户订阅返回 null */
export async function listEntries(userId: string, feedId: string, limit = 20, offset = 0) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  const safeLimit = Math.min(Math.max(1, limit), 100)
  const safeOffset = Math.max(0, offset)

  // entries-by-date 视图按 publishedAt 排序：descending 倒序 + skip/limit 分页
  const result = await feedDb.view("main", "entries-by-date", {
    descending: true,
    limit: safeLimit,
    skip: safeOffset,
  })
  const items = await Promise.all(
    result.rows.map((row) => feedDb.get((row.value as { _id: string })._id)),
  )
  return items.map((doc: any) => ({
    id: doc._id,
    title: doc.title,
    url: doc.url,
    publishedAt: doc.publishedAt,
    summary: doc.summary ?? doc.description ?? stripHtml(doc.content ?? "").slice(0, 300),
    author: doc.author,
  }))
}

/** 在某源已抓取条目中按关键词搜索标题（简单过滤）；非用户订阅返回 null */
export async function searchEntries(userId: string, feedId: string, keyword: string, limit = 20) {
  if (!(await assertSubscribed(userId, feedId))) return null
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  const needle = keyword.trim().toLowerCase()
  const safeLimit = Math.min(Math.max(1, limit), 100)

  // 用 Mango 查询 title 字段前缀；再在内存中对标题/摘要做包含匹配
  const result = await feedDb.find({
    selector: { type: "entry" },
    fields: ["_id", "title", "url", "publishedAt", "summary", "description", "content", "author"],
    limit: safeLimit,
  })
  const hits = (result.docs as any[]).filter((d) => {
    const hay = `${d.title ?? ""} ${d.summary ?? ""} ${d.description ?? ""} ${stripHtml(d.content ?? "").slice(0, 500)}`.toLowerCase()
    return hay.includes(needle)
  })
  return hits.slice(0, safeLimit).map((d: any) => ({
    id: d._id,
    title: d.title,
    url: d.url,
    publishedAt: d.publishedAt,
    summary: d.summary ?? d.description ?? stripHtml(d.content ?? "").slice(0, 300),
    author: d.author,
  }))
}

/** 去除 HTML 标签，返回纯文本 */
function stripHtml(html: string): string {
  return html
    ?.replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .trim() || ""
}
