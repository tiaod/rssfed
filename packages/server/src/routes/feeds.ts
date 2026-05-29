import { Hono } from "hono"
import { rssParser } from "../rss/parser"
import { nanoServer } from "../couchdb/client"
import { COUCHDB_GLOBAL } from "../db"
import { fetchQueue } from "../workers"

export const feedsRouter = new Hono()

feedsRouter.post("/discover", async (c) => {
  const { url } = await c.req.json()
  if (!url) return c.json({ error: "url required" }, 400)

  try {
    const feed = await rssParser.parseURL(url)
    const db = nanoServer.use(COUCHDB_GLOBAL)
    const feedId = `feed:${Buffer.from(url).toString("base64").slice(0, 12)}`

    await db.insert({
      _id: feedId,
      type: "feed",
      url,
      title: feed.title ?? url,
      description: feed.description,
      siteUrl: feed.link,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as any)

    await fetchQueue.add(`fetch:${feedId}`, { feedId, url })

    return c.json({ feedId, title: feed.title, items: feed.items.length })
  } catch (err) {
    return c.json({ error: `Failed to parse feed: ${String(err)}` }, 422)
  }
})

feedsRouter.get("/:feedId", async (c) => {
  const { feedId } = c.req.param()
  const db = nanoServer.use(COUCHDB_GLOBAL)

  try {
    const feed = await db.get(feedId)
    return c.json(feed)
  } catch {
    return c.json({ error: "feed not found" }, 404)
  }
})