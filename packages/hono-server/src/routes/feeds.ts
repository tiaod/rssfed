import { Hono, type Context, type Next } from "hono"
import { inArray, eq } from "drizzle-orm"
import { rssParser, formatFeedError } from "../rss/parser"
import { createCouchDb, ensureFeedDatabase, ensureUserStateDatabase } from "../couchdb/client"
import { db, feeds } from "../db"
import { fetchQueue } from "../workers"
import { auth } from "../auth"

type FeedsVariables = { userId: string }

/** 校验登录态并将 userId 写入 context（未登录 401） */
async function requireAuth(c: Context<{ Variables: FeedsVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
}

/** 校验管理员权限（未登录 401 / 非管理员 403） */
async function requireAdmin(c: Context<{ Variables: FeedsVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  if (session.user.role !== "admin") return c.json({ error: "forbidden" }, 403)
  c.set("userId", session.user.id)
  await next()
}

export const feedsRouter = new Hono<{ Variables: FeedsVariables }>()

type ParsedFeed = Awaited<ReturnType<typeof rssParser.parseURL>>

/** 获取全部订阅源注册表（仅管理员） */
feedsRouter.get("/", requireAdmin, async (c) => {
  const allFeeds = await db.select().from(feeds)
  return c.json(allFeeds.map((f) => ({
    id: f.id,
    url: f.url,
    title: f.title,
    description: f.description,
    siteUrl: f.siteUrl,
    image: f.image,
    status: f.status === "paused" ? "paused" : f.errorMessage ? "error" : "active",
    errorMessage: f.errorMessage,
    lastFetchedAt: f.lastFetchedAt?.toISOString(),
    createdAt: f.createdAt.toISOString(),
  })))
})

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
    return c.json({ error: `Failed to parse feed: ${formatFeedError(url, err)}` }, 422)
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

/** 获取当前用户的订阅列表，合并注册表抓取状态（active/paused/error） */
feedsRouter.get("/subscriptions", requireAuth, async (c) => {
  const userId = c.get("userId")
  const userDb = createCouchDb(await ensureUserStateDatabase(userId))

  const { docs } = await userDb.find({
    selector: { type: "subscription" },
    fields: ["feedId", "title", "siteUrl", "image", "description", "category", "createdAt"],
    limit: 100,
  })

  const feedIds = docs.map((d: any) => d.feedId).filter(Boolean)
  const registry = feedIds.length
    ? await db.select().from(feeds).where(inArray(feeds.id, feedIds))
    : []
  const byId = new Map(registry.map((f) => [f.id, f]))

  return c.json(docs.map((d: any) => {
    const reg = byId.get(d.feedId)
    // 状态由真实字段判定：暂停优先，其次错误，其余为活跃
    const status = reg?.status === "paused" ? "paused"
      : reg?.errorMessage ? "error"
      : "active"
    return {
      feedId: d.feedId,
      title: d.title,
      siteUrl: d.siteUrl,
      image: d.image,
      description: d.description,
      category: d.category,
      createdAt: d.createdAt,
      status,
      errorMessage: reg?.errorMessage ?? undefined,
      lastFetchedAt: reg?.lastFetchedAt?.toISOString() ?? undefined,
    }
  }))
})

/** 暂停/恢复订阅抓取（仅管理员） */
feedsRouter.patch("/:feedId", requireAdmin, async (c) => {
  const feedId = c.req.param("feedId")!
  const { status } = await c.req.json()
  if (status !== "active" && status !== "paused") {
    return c.json({ error: "status must be 'active' or 'paused'" }, 400)
  }
  const updated = await db.update(feeds)
    .set({ status })
    .where(eq(feeds.id, feedId))
    .returning({ id: feeds.id })
  if (!updated.length) return c.json({ error: "feed not found" }, 404)
  return c.json({ feedId, status })
})

/** 修改订阅源信息（仅管理员）：title / url / description / siteUrl / image */
feedsRouter.put("/:feedId", requireAdmin, async (c) => {
  const feedId = c.req.param("feedId")!
  const body = await c.req.json()
  const patch: Record<string, string> = {}
  for (const key of ["title", "url", "description", "siteUrl", "image"]) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  if (!Object.keys(patch).length) {
    return c.json({ error: "no fields to update" }, 400)
  }
  const updated = await db.update(feeds)
    .set(patch)
    .where(eq(feeds.id, feedId))
    .returning({ id: feeds.id })
  if (!updated.length) return c.json({ error: "feed not found" }, 404)
  return c.json({ feedId, updated: true })
})

/** 立即重新抓取订阅源（仅管理员）：清空错误并加入抓取队列 */
feedsRouter.post("/:feedId/refetch", requireAdmin, async (c) => {
  const feedId = c.req.param("feedId")!
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1)
  if (!feed) return c.json({ error: "feed not found" }, 404)

  await db.update(feeds).set({ errorMessage: null }).where(eq(feeds.id, feedId))
  // jobId 用 feedId 本身做去重键（BullMQ 不允许 jobId 含冒号）
  await fetchQueue.add(`fetch:${feedId}`, { feedId, url: feed.url }, { jobId: feedId })

  return c.json({ feedId, queued: true })
})

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
