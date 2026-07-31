import { Hono } from "hono"
import { rssParser } from "../rss/parser"
import { createCouchDb, feedDbName, ensureFeedDatabase } from "../couchdb/client"
import { db, feeds } from "../db"
import { fetchQueue } from "../workers"

export const feedsRouter = new Hono()

/** 发现并订阅一个新 RSS 订阅源 */
feedsRouter.post("/discover", async (c) => {
  const { url } = await c.req.json()
  if (!url) return c.json({ error: "url required" }, 400)

  try {
    const parsed = await rssParser.parseURL(url)
    const feedId = `feed:${Buffer.from(url).toString("base64").slice(0, 12)}`

    // 写入 PostgreSQL feed 注册表
    await db.insert(feeds).values({
      id: feedId,
      url,
      title: parsed.title ?? url,
      description: parsed.description,
      siteUrl: parsed.link,
    }).onConflictDoNothing()

    // 确保 per-feed CouchDB 库存在
    await ensureFeedDatabase(feedId)
    const feedDb = createCouchDb(feedDbName(feedId))

    // 写入 FeedDoc
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

    return c.json({ feedId, title: parsed.title, items: parsed.items.length })
  } catch (err) {
    return c.json({ error: `Failed to parse feed: ${String(err)}` }, 422)
  }
})

/** 获取单个订阅源信息 */
feedsRouter.get("/:feedId", async (c) => {
  const { feedId } = c.req.param()
  const feedDb = createCouchDb(feedDbName(feedId))

  try {
    const feed = await feedDb.get(feedId)
    return c.json(feed)
  } catch {
    return c.json({ error: "feed not found" }, 404)
  }
})
