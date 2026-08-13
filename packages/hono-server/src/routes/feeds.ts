import { Hono, type Context, type Next } from "hono"
import crypto from "node:crypto"
import { inArray, eq } from "drizzle-orm"
import { parseFeedUrl, parseFeedContent, formatFeedError, type ParsedFeed } from "../rss/parser"
import { parseOpml, type OpmlFeed } from "../rss/opml"
import { createCouchDb, ensureFeedDatabase, ensureUserStateDatabase } from "../couchdb/client"
import { db, feeds } from "../db"
import { enqueueFetch } from "../workers"
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

/**
 * 由 URL 确定性派生 feedId：对完整 URL 做 sha256 后取 base64url 前 16 位。
 * 历史实现取 base64url(URL).slice(0,12)，只编码了前 9 字节，
 * 导致 https://www.a.com 与 https://www.b.com 这类前缀相同的 URL 撞 ID；
 * 改用完整 URL 哈希可彻底避免冲突（base64url 保证路径安全，不含 / + =）。
 */
export function deriveFeedId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("base64url").slice(0, 16)
}

/**
 * 解析 feedId：URL 已注册时复用其现有 ID（兼容历史短 ID 数据），
 * 否则按完整 URL 哈希派生新 ID。
 */
async function resolveFeedId(url: string): Promise<string> {
  const existing = await db.query.feeds.findFirst({
    where: eq(feeds.url, url),
    columns: { id: true },
  })
  return existing?.id ?? deriveFeedId(url)
}

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

/** 注册后的 feed 元信息，用于写入订阅文档 */
interface FeedMeta {
  feedId: string
  title: string
  siteUrl?: string
  description?: string
}

/**
 * 确保 feed 已登记：PostgreSQL 注册表 + per-feed CouchDB 库。
 * 首轮解析失败不阻塞导入（用 OPML 自带标题兜底注册），
 * 统一入队抓取（jobId 去重），由 Worker 更新元数据或标记错误。
 */
async function ensureFeedRegistered(item: OpmlFeed): Promise<FeedMeta> {
  // 已注册过的 URL 复用现有 ID，避免与历史短 ID 数据分裂；新 URL 按完整 URL 哈希派生
  const feedId = await resolveFeedId(item.url)

  let parsed: ParsedFeed | null = null
  try {
    parsed = await parseFeedUrl(item.url)
  } catch {
    // 忽略：用 OPML 标题兜底，错误状态留给 Worker 抓取时标记
  }

  const title = parsed?.title ?? item.title ?? item.url
  await db.insert(feeds).values({
    id: feedId,
    url: item.url,
    title,
    description: parsed?.description,
    siteUrl: parsed?.link,
  }).onConflictDoNothing()

  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  try {
    await feedDb.get(feedId)
  } catch {
    await feedDb.insert({
      _id: feedId,
      type: "feed",
      url: item.url,
      title,
      description: parsed?.description,
      siteUrl: parsed?.link,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as any)
  }

  // 无论首轮解析成败都入队一次抓取（enqueueFetch 内含 jobId 去重与旧记录清理）
  await enqueueFetch(feedId, item.url)

  return {
    feedId,
    title,
    siteUrl: parsed?.link,
    description: parsed?.description,
  }
}

/** 为用户写入订阅文档；已订阅过（_id 冲突 409）则跳过并返回 false */
async function addSubscriptionIfAbsent(
  userDb: ReturnType<typeof createCouchDb>,
  item: OpmlFeed,
  meta: FeedMeta,
): Promise<boolean> {
  try {
    await userDb.insert({
      _id: `subscription:${meta.feedId}`,
      type: "subscription",
      feedId: meta.feedId,
      title: meta.title,
      siteUrl: meta.siteUrl,
      description: meta.description,
      category: item.category,
      createdAt: new Date().toISOString(),
    } as any)
    return true
  } catch (err: any) {
    // CouchDB 文档冲突 = 该用户已订阅过，跳过
    if (err?.statusCode === 409 || err?.error === "conflict") return false
    throw err
  }
}

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

/** 获取当前用户的订阅列表，合并注册表抓取状态（active/paused/error） */
feedsRouter.get("/subscriptions", requireAuth, async (c) => {
  const userId = c.get("userId")
  const userDb = createCouchDb(await ensureUserStateDatabase(userId))

  // 用 allDocs 主键范围查询订阅文档（find 的 limit 默认 25/上限 100，
  // 订阅源很多（如 OPML 批量导入数百个）时会被截断）
  const { rows } = await userDb.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  const docs = rows.map((r) => r.doc).filter(Boolean) as any[]

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
      // 最后抓到新条目的时间：前端据此只同步「上次同步后有过新内容」的源
      lastNewEntryAt: reg?.lastNewEntryAt?.toISOString() ?? undefined,
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
