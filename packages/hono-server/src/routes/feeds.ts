import { Hono } from "hono"
import { rssParser } from "../rss/parser"
import { createCouchDb, ensureFeedDatabase } from "../couchdb/client"
import { db, feeds } from "../db"
import { fetchQueue } from "../workers"

export const feedsRouter = new Hono()

type ParsedFeed = Awaited<ReturnType<typeof rssParser.parseURL>>

/** 发现并订阅一个新 RSS 订阅源 */
feedsRouter.post("/discover", async (c) => {
  const { url } = await c.req.json()
  if (!url) return c.json({ error: "url required" }, 400)

  try {
    const parsed = await rssParser.parseURL(url)
    // feedId 由 URL 确定性派生；base64url 编码保证 URL 路径安全（不含 / + = 等特殊字符）
    const feedId = Buffer.from(url).toString("base64url").slice(0, 12)

    await registerFeed(feedId, url, parsed)
    await seedFeedDoc(feedId, url, parsed)

    return c.json({ feedId, title: parsed.title, items: parsed.items.length })
  } catch (err) {
    return c.json({ error: `Failed to parse feed: ${String(err)}` }, 422)
  }
})

/** 写入 PostgreSQL feed 注册表（已存在则跳过） */
async function registerFeed(feedId: string, url: string, parsed: ParsedFeed) {
  await db.insert(feeds).values({
    id: feedId,
    url,
    title: parsed.title ?? url,
    description: parsed.description,
    siteUrl: parsed.link,
  }).onConflictDoNothing()
}

/** 首次发现时写入 FeedDoc 并立即加入抓取队列 */
async function seedFeedDoc(feedId: string, url: string, parsed: ParsedFeed) {
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))

  // FeedDoc 已存在则跳过
  try {
    await feedDb.get(feedId)
  } catch {
    await feedDb.insert({
      _id: feedId,
      type: "feed",
      url,
      title: parsed.title ?? url,
      description: parsed.description,
      siteUrl: parsed.link,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as any)
    // 首次发现，立即加入抓取队列
    await fetchQueue.add(`fetch:${feedId}`, { feedId, url })
  }
}

/** 获取单个订阅源信息 */
feedsRouter.get("/:feedId", async (c) => {
  const { feedId } = c.req.param()
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))

  try {
    const feed = await feedDb.get(feedId)
    return c.json(feed)
  } catch {
    return c.json({ error: "feed not found" }, 404)
  }
})
