import { Hono, type Context, type Next } from "hono"
import { eq } from "drizzle-orm"
import { parseFeedUrl, formatFeedError, type ParsedFeed } from "../rss/parser"
import { parseOpml, type OpmlFeed } from "../rss/opml"
import { createCouchDb, ensureFeedDatabase, ensureUserStateDatabase } from "../couchdb/client"
import { db, feeds } from "../db"
import { enqueueFetch } from "../workers"
import { DEFAULT_IMAGE_OPTIONS } from "../rss/entry-images"
import {
  resolveFeedId,
  ensureFeedRegistered,
  addSubscriptionIfAbsent,
  listSubscriptionsForUser,
} from "../services/feeds"
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
    // per-feed 图片缓存策略（见 rss/entry-images.ts）
    cacheImages: f.cacheImages ?? false,
    maxImageCount: f.maxImageCount ?? null,
    maxImageWidth: f.maxImageWidth ?? null,
    avifQuality: f.avifQuality ?? null,
    maxSourceImageBytes: f.maxSourceImageBytes ?? null,
  })))
})

/** 发现并订阅一个新 RSS 订阅源 */
feedsRouter.post("/discover", async (c) => {
  const { url } = await c.req.json()
  if (!url) return c.json({ error: "url required" }, 400)

  try {
    const parsed = await parseFeedUrl(url)
    // feedId 由完整 URL 哈希确定性派生（已注册过的 URL 复用其现有 ID）
    const feedId = await resolveFeedId(url)

    await registerFeed(feedId, url, parsed)
    await seedFeedDoc(feedId, url, parsed)

    return c.json({ feedId, title: parsed.title, items: parsed.items.length })
  } catch (err) {
    return c.json({ error: `Failed to parse feed: ${formatFeedError(url, err)}` }, 422)
  }
})

/** 导入 OPML：批量注册订阅源并按 OPML 分组结构为当前用户创建订阅 */
feedsRouter.post("/import-opml", requireAuth, async (c) => {
  const userId = c.get("userId")
  const { opml } = await c.req.json()
  if (!opml || typeof opml !== "string") {
    return c.json({ error: "opml content required" }, 400)
  }

  // 1. 解析 OPML 为订阅源列表（含分组信息）
  let items: OpmlFeed[]
  try {
    items = parseOpml(opml)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422)
  }
  if (!items.length) {
    return c.json({ error: "OPML 中未发现任何订阅源" }, 422)
  }

  // 2. 按 URL 去重（同一订阅源可能在文件中出现多次）
  const unique = [...new Map(items.map((i) => [i.url, i])).values()]

  const userDb = createCouchDb(await ensureUserStateDatabase(userId))
  const failed: { url: string, error: string }[] = []
  let imported = 0
  let skipped = 0

  // 3. 有限并发处理：注册 feed + 写入用户订阅，单个失败不影响其余
  await mapWithConcurrency(unique, 5, async (item) => {
    try {
      const meta = await ensureFeedRegistered(item)
      const subscribed = await addSubscriptionIfAbsent(userDb, item, meta)
      if (subscribed) imported++
      else skipped++
    } catch (err) {
      failed.push({ url: item.url, error: formatFeedError(item.url, err) })
    }
  })

  return c.json({ total: unique.length, imported, skipped, failed })
})

/** 有限并发处理任务（批量导入时避免并发打爆目标站点 / 数据库） */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      const item = items[current]
      if (item === undefined) break
      await fn(item)
    }
  })
  await Promise.all(workers)
}

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
    // 首次发现，立即加入抓取队列（enqueueFetch 内含 jobId 去重与旧记录清理）
    await enqueueFetch(feedId, url)
  }
}

/** 获取当前用户的订阅列表（feed + bot），合并注册表抓取状态（active/paused/error） */
feedsRouter.get("/subscriptions", requireAuth, async (c) => {
  const userId = c.get("userId")
  const subs = await listSubscriptionsForUser(userId)
  return c.json(subs)
})

/** 获取全局默认图片缓存参数（仅管理员），供前端展示输入框 placeholder 默认值 */
feedsRouter.get("/image-defaults", requireAdmin, async (c) => {
  return c.json(DEFAULT_IMAGE_OPTIONS)
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

/** 修改订阅源信息（仅管理员）：title / url / description / siteUrl / image 及 per-feed 图片缓存策略 */
feedsRouter.put("/:feedId", requireAdmin, async (c) => {
  const feedId = c.req.param("feedId")!
  const body = await c.req.json()
  // 图片缓存策略字段（数值/布尔；传 null 表示重置回全局默认）
  const imageKeys = ["maxImageCount", "maxImageWidth", "avifQuality", "maxSourceImageBytes"] as const
  type ImageKey = typeof imageKeys[number]
  const patch: Record<string, string | number | boolean | null> = {}
  for (const key of ["title", "url", "description", "siteUrl", "image"] as const) {
    if (typeof body[key] === "string") patch[key] = body[key]
  }
  if (typeof body.cacheImages === "boolean") patch.cacheImages = body.cacheImages
  for (const key of imageKeys) {
    const v = body[key]
    if (v === null) {
      patch[key] = null // 显式重置为全局默认
    } else if (v !== undefined) {
      const n = Number(v)
      if (!Number.isNaN(n) && n >= 0) patch[key] = Math.floor(n)
    }
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
  // enqueueFetch：jobId 用 feedId 去重（BullMQ 不允许 jobId 含冒号），并清理旧记录
  await enqueueFetch(feedId, feed.url)

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
