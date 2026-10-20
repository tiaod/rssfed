import crypto from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { parseFeedUrl, formatFeedError, type ParsedFeed } from "../rss/parser"
import type { OpmlFeed } from "../rss/opml"
import { createCouchDb, ensureFeedDatabase, ensureTimelineDatabase } from "../couchdb/client"
import { feedDocId } from "../couchdb/doc-ids"
import { db, feeds, bots } from "../db"
import { enqueueFetch } from "../workers"

/**
 * 用户级订阅服务层。
 *
 * 这里集中「按用户身份 + 归属校验」的订阅读写逻辑，供两类调用方复用：
 *  1. REST 路由（feeds.ts 里的用户订阅相关端点）
 *  2. MCP 工具（list_subscriptions / add / remove / pause / resume / update / refetch）
 *
 * 原则：所有函数都以 userId 为边界，只操作该用户的数据；
 * 涉及「改 feed 全局状态」的操作（pause/resume/update/refetch）必须先校验
 * 该 feed 确属当前用户的订阅，绝不暴露 admin 级全局操作。
 */

/** 注册后的 feed 元信息，用于写入订阅文档 */
export interface FeedMeta {
  feedId: string
  title: string
  siteUrl?: string
  description?: string
}

/**
 * 由 URL 确定性派生 feedId：对完整 URL 做 sha256 后取 base64url 前 16 位。
 * （历史实现用 base64url(URL).slice(0,12)，前缀相同会撞 ID；改用完整 URL 哈希避免冲突。）
 */
export function deriveFeedId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("base64url").slice(0, 16)
}

/**
 * 解析 feedId：URL 已注册时复用其现有 ID（兼容历史短 ID 数据），
 * 否则按完整 URL 哈希派生新 ID。
 */
export async function resolveFeedId(url: string): Promise<string> {
  const existing = await db.query.feeds.findFirst({
    where: eq(feeds.url, url),
    columns: { id: true },
  })
  return existing?.id ?? deriveFeedId(url)
}

/**
 * 确保 feed 已登记：PostgreSQL 注册表 + per-feed CouchDB 库。
 *
 * 对**已注册**的 feed：不再联网探测（注册表里已有元信息），也不重复入队抓取 ——
 * 调度器本来就在轮询它，重复入队只会让同一个源多下一次。OPML 重复导入时这能省掉
 * 「每个源先内联下载一遍 + worker 再下载一遍」的两份浪费。
 *
 * 对**新** feed：默认内联探测一次拿标题/描述（单次添加需要即时确认），
 * `probe: false` 时跳过 —— OPML 导入用 OPML 里的标题兜底，真正的抓取交给 worker，
 * 不必在导入请求里同步下载几十上百个源（首轮解析失败也不阻塞，错误状态由 worker 标记）。
 */
export async function ensureFeedRegistered(
  item: OpmlFeed,
  options: { probe?: boolean } = {},
): Promise<FeedMeta> {
  const probe = options.probe ?? true
  // 一次查询同时拿到 id 与「是否已注册」，避免 resolveFeedId 之后再查一遍
  const existing = await db.query.feeds.findFirst({ where: eq(feeds.url, item.url) })
  const feedId = existing?.id ?? deriveFeedId(item.url)

  let parsed: ParsedFeed | null = null
  if (!existing && probe) {
    try {
      parsed = await parseFeedUrl(item.url)
    } catch {
      // 忽略：用标题兜底，错误状态由 Worker 抓取时标记
    }
  }

  const title = parsed?.title ?? existing?.title ?? item.title ?? item.url
  await db.insert(feeds).values({
    id: feedId,
    url: item.url,
    title,
    description: parsed?.description,
    siteUrl: parsed?.link,
  }).onConflictDoNothing()

  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  try {
    await feedDb.get(feedDocId(feedId))
  } catch {
    // 只写展示字段：抓取簿记（lastFetchedAt/验证器/错误）在 PostgreSQL `feeds` 表，
    // 不写进 FeedDoc —— 这份文档会复制进每个用户聚合库（见 workers/feed-doc.ts）。
    await feedDb.insert({
      _id: feedDocId(feedId),
      type: "feed",
      url: item.url,
      title,
      description: parsed?.description,
      siteUrl: parsed?.link,
      createdAt: new Date().toISOString(),
    } as any)
  }

  // 只有新 feed 需要首抓；已注册的由调度器按轮次抓（手动「立即抓取」走 refetchFeed）
  if (!existing) await enqueueFetch(feedId, item.url)

  return {
    feedId,
    title,
    siteUrl: parsed?.link ?? existing?.siteUrl ?? undefined,
    description: parsed?.description ?? existing?.description ?? undefined,
  }
}

/** 为用户写入订阅文档；已订阅过（_id 冲突 409）则跳过并返回 false */
export async function addSubscriptionIfAbsent(
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

/**
 * 按 URL 为单个用户添加订阅（内联 discover）。
 * 返回结果：{ feedId, title, added }，added=false 表示已订阅过。
 */
export async function addSubscriptionByUrl(userId: string, url: string, category?: string) {
  const item: OpmlFeed = { title: url, url, category }
  const meta = await ensureFeedRegistered(item)
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const added = await addSubscriptionIfAbsent(userDb, item, meta)
  return { feedId: meta.feedId, title: meta.title, added }
}

/** 读取当前用户已订阅的 feedId 集合（用于归属校验，避免全量读文档） */
export async function getSubscribedFeedIds(userId: string): Promise<Set<string>> {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const { rows } = await userDb.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  return new Set(
    rows
      .map((r) => (r.doc as any)?.feedId)
      .filter((v: unknown): v is string => typeof v === "string"),
  )
}

/**
 * 删除当前用户的某个订阅（用户库里的 subscription 文档）。
 * @returns true=已删除，false=未找到该订阅
 */
export async function removeSubscription(userId: string, feedId: string): Promise<boolean> {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const docId = `subscription:${feedId}`
  try {
    const doc = await userDb.get(docId) as { _id: string, _rev: string }
    await userDb.destroy(docId, doc._rev)
    return true
  } catch {
    return false
  }
}

/**
 * 设置某 feed 的抓取状态（active/paused），**仅当该 feed 属当前用户订阅时**。
 * @returns true=已更新，false=该 feed 非当前用户订阅或不存在
 */
export async function setSubscriptionStatus(userId: string, feedId: string, status: "active" | "paused"): Promise<boolean> {
  const subscribed = await getSubscribedFeedIds(userId)
  if (!subscribed.has(feedId)) return false
  const updated = await db.update(feeds)
    .set({ status })
    .where(eq(feeds.id, feedId))
    .returning({ id: feeds.id })
  return updated.length > 0
}

/**
 * 更新某 feed 的元信息（title/url/description/siteUrl/image），**仅当属于当前用户订阅时**。
 */
export async function updateSubscriptionMeta(
  userId: string,
  feedId: string,
  patch: Partial<{ title: string, url: string, description: string, siteUrl: string, image: string }>,
): Promise<boolean> {
  const subscribed = await getSubscribedFeedIds(userId)
  if (!subscribed.has(feedId)) return false
  const clean: Record<string, string> = {}
  for (const key of ["title", "url", "description", "siteUrl", "image"]) {
    const v = patch[key as keyof typeof patch]
    if (v !== undefined) clean[key] = v
  }
  if (!Object.keys(clean).length) return false
  const [before] = await db.select({ url: feeds.url }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
  const updated = await db.update(feeds)
    .set(clean)
    .where(eq(feeds.id, feedId))
    .returning({ id: feeds.id })
  if (!updated.length) return false
  await requeueAfterUrlChange(feedId, before?.url, clean.url)
  return true
}

/** 清掉错误状态并按当前 URL 重建抓取任务（enqueueFetch 会替换掉队列里旧 URL 的 job） */
async function resetAndEnqueue(feedId: string, url: string): Promise<void> {
  await db.update(feeds).set({ errorMessage: null }).where(eq(feeds.id, feedId))
  await enqueueFetch(feedId, url)
}

/**
 * URL 变更后的收尾：清错 + 按新地址重建抓取任务。
 *
 * 这一步不能省：enqueueFetch 按 jobId 去重，队列里若还压着一个旧 URL 的 job，
 * 不先清掉的话新地址根本进不了队列（静默无效），表现就是「改了 URL、点了立即抓取，
 * 源还是没数据，也不报错」。返回是否真的触发了重建。
 */
export async function requeueAfterUrlChange(
  feedId: string,
  oldUrl: string | undefined,
  newUrl: string | undefined,
): Promise<boolean> {
  if (!newUrl || newUrl === oldUrl) return false
  await resetAndEnqueue(feedId, newUrl)
  return true
}

/** 触发某 feed 立即重新抓取（清空错误），**仅当属于当前用户订阅时** */
export async function refetchFeed(userId: string, feedId: string): Promise<boolean> {
  const subscribed = await getSubscribedFeedIds(userId)
  if (!subscribed.has(feedId)) return false
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1)
  if (!feed) return false
  await resetAndEnqueue(feedId, feed.url)
  return true
}

/** 当前用户订阅列表（feed + bot），合并注册表抓取状态（active/paused/error） */
export async function listSubscriptionsForUser(userId: string) {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const { rows } = await userDb.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  const docs = rows.map((r) => r.doc).filter(Boolean) as any[]

  // 脏订阅文档防御：feedId 必须是非空字符串。
  // 若把 feedId 为空的文档返回给前端，它既取不到对应的 CouchDB 库名
  // （/api/couchdb/targets 的映射里没有这个 key），也定位不到任何远端库。
  const hasValidFeedId = (d: any) => typeof d.feedId === "string" && d.feedId.length > 0
  const feedDocs = docs.filter((d: any) => d.kind !== "bot" && hasValidFeedId(d))
  const botDocs = docs.filter((d: any) => d.kind === "bot" && hasValidFeedId(d))
  const feedIds = feedDocs.map((d: any) => d.feedId).filter(Boolean)
  const botIds = botDocs.map((d: any) => String(d.feedId).replace(/^bot:/, "")).filter(Boolean)

  const [feedRegistry, botRegistry] = await Promise.all([
    feedIds.length ? db.select().from(feeds).where(inArray(feeds.id, feedIds)) : [],
    botIds.length ? db.select().from(bots).where(inArray(bots.id, botIds)) : [],
  ])
  const feedById = new Map(feedRegistry.map((f) => [f.id, f]))
  const botById = new Map(botRegistry.map((b) => [b.id, b]))

  return [
    ...feedDocs.map((d: any) => {
      const reg = feedById.get(d.feedId)
      const status = reg?.status === "paused" ? "paused"
        : reg?.errorMessage ? "error"
        : "active"
      return {
        feedId: d.feedId,
        kind: "feed" as const,
        title: d.title,
        siteUrl: d.siteUrl,
        image: d.image,
        description: d.description,
        category: d.category,
        createdAt: d.createdAt,
        status,
        errorMessage: reg?.errorMessage ?? undefined,
        lastFetchedAt: reg?.lastFetchedAt?.toISOString() ?? undefined,
        lastNewEntryAt: reg?.lastNewEntryAt?.toISOString() ?? undefined,
        // 抓取地址：编辑订阅弹窗只读展示（前端离线时回退本地 FeedDoc）
        feedUrl: reg?.url ?? undefined,
      }
    }),
    ...botDocs.map((d: any) => {
      const botId = String(d.feedId).replace(/^bot:/, "")
      const reg = botById.get(botId)
      return {
        feedId: d.feedId,
        kind: "bot" as const,
        title: d.title ?? reg?.name,
        siteUrl: undefined,
        image: d.image ?? reg?.avatarUrl,
        description: d.description ?? reg?.description,
        category: d.category,
        createdAt: d.createdAt,
        status: reg?.isActive === false ? "paused" : "active",
        lastNewEntryAt: reg?.lastNewEntryAt?.toISOString() ?? undefined,
        // bot 没有 RSS 地址：前端用它在编辑订阅弹窗里拼联邦地址 `@用户名@域名`
        preferredUsername: reg?.preferredUsername ?? undefined,
      }
    }),
  ]
}

/** 复用格式错误导出，供 MCP 工具在解析失败时返回可读信息 */
export { formatFeedError }
