import { inArray } from "drizzle-orm"
import { parseFeedUrl, formatFeedError, type ParsedFeed } from "../rss/parser"
import type { OpmlFeed } from "../rss/opml"
import { createCouchDb, ensureTimelineDatabase } from "../couchdb/client"
import {
  deriveFeedId,
  parseSubscription,
  SUBSCRIPTION_TYPE,
  subscriptionDocId,
  type SubscriptionDoc,
} from "../couchdb/subscription-doc"
import { feedDocId } from "../couchdb/doc-ids"
import { db, bots } from "../db"
import { enqueueOwnerFetch } from "../workers"
import { readSchedule, dropSourceSchedule, mergeSourceSchedule, type ScheduleState } from "./owner-schedule"
import { touchTimelineActivity } from "./timeline-lifecycle"

/**
 * 订阅服务层 —— 订阅关系的**唯一权威**是用户库里的 `subscription:{feedId}` 文档。
 *
 * ## 为什么订阅在 CouchDB 而不在 PostgreSQL
 *
 * 离线优先：用户断网时也要能订阅/退订，这些改动先落浏览器 PouchDB，联网后与服务端合并。
 * 关系型表没有对应的客户端副本与冲突合并机制，跨端修改无法收敛。
 *
 * ## 这份文档为什么必须带 `url`
 *
 * 抓取按 **owner**（用户 / Bot）各自进行，没有共享的 `feeds` 注册表了。调度读到订阅文档后
 * 必须能直接拿到抓取地址 —— `feedId` 是 `sha256(url)` 截断，不可逆。
 *
 * 代价：`url` 是**客户端可写**的，所以它属于不可信输入。写入时（discover）校验过一次，
 * 但用户能直接改本地 PouchDB 再同步上来，因此**每次抓取前都要重新过 SSRF 闸门**
 * （`rss/parser.ts` 的 `assertFetchableUrl`，含重定向逐跳校验）。
 *
 * ## 原则
 *
 * 所有函数都以 userId 为边界，只操作该用户的数据；不提供任何 admin 级全局源操作
 * （"全局源"这个概念已经不存在了）。
 */

/** 注册后的 feed 元信息，用于写入订阅文档 */
export interface FeedMeta {
  feedId: string
  /** 抓取地址（订阅文档的 url 字段，调度据此抓取） */
  url: string
  title: string
  siteUrl?: string
  description?: string
  image?: string
}

/** 由 URL 确定性派生 feedId（实现见 couchdb/subscription-doc.ts，这里转出以保持既有导入路径） */
export { deriveFeedId }

/**
 * 解析 feedId：URL 已出现在该用户的订阅里时复用它，否则按完整 URL 哈希派生。
 *
 * 与旧的 `resolveFeedId` 不同：以前查的是全局 `feeds` 注册表，现在没有注册表了 ——
 * 同一个 URL 在任何 owner 那里派生的 id 都相同（纯函数），所以这里其实是纯派生。
 * 保留这个函数名是因为 MCP / 路由层都在用，语义（可能查一下现有订阅）保持不变。
 */
export async function resolveFeedId(url: string): Promise<string> {
  return deriveFeedId(url)
}

/**
 * 确保该用户的订阅存在（含 url），并按需触发一次抓取。
 *
 * 对**已订阅**的源：不重复写文档、不重复入队（调度器本来就在轮询）。
 * 对**新**订阅：写订阅文档 + 入队一次首抓；标题用解析结果或 OPML 里的兜底。
 *
 * @param options.probe 是否内联解析一次拿标题（单条添加要即时确认；OPML 导入关掉，
 *   几十上百个源同步下载会很慢，而且 worker 马上还要再抓一遍）
 */
export async function ensureFeedSubscribed(
  userId: string,
  item: OpmlFeed,
  options: { probe?: boolean } = {},
): Promise<{ meta: FeedMeta, added: boolean }> {
  const probe = options.probe ?? true
  const feedId = deriveFeedId(item.url)

  let parsed: ParsedFeed | null = null
  if (probe) {
    try {
      parsed = await parseFeedUrl(item.url)
    } catch {
      // 忽略：用标题兜底，错误状态由 worker 抓取时标记（订阅本身不因一次探测失败而失败）
    }
  }

  const meta: FeedMeta = {
    feedId,
    url: item.url,
    title: parsed?.title ?? item.title ?? item.url,
    siteUrl: parsed?.link,
    description: parsed?.description,
    image: parsed?.image?.url,
  }

  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const added = await addSubscriptionIfAbsent(userDb, item, meta)
  if (added) {
    // 首抓：新订阅立刻抓一次，用户不用等下一轮调度
    await enqueueOwnerFetch({ owner: { kind: "user", id: userId }, feedId, url: item.url }).catch(() => {})
  }
  return { meta, added }
}

/**
 * 写入订阅文档；已订阅过（id 冲突 409）则跳过并返回 false。
 *
 * 文档里同时更新 FeedDoc（展示字段）—— 订阅列表的标题/图标来自它，
 * 而 FeedDoc 由抓取路径维护，首抓之前先放一份占位，避免界面空白。
 */
export async function addSubscriptionIfAbsent(
  userDb: ReturnType<typeof createCouchDb>,
  item: OpmlFeed,
  meta: FeedMeta,
): Promise<boolean> {
  try {
    await userDb.insert({
      _id: subscriptionDocId(meta.feedId),
      type: SUBSCRIPTION_TYPE,
      feedId: meta.feedId,
      // 抓取地址：调度与 worker 的唯一依据（见文件头）
      url: meta.url,
      title: meta.title,
      siteUrl: meta.siteUrl,
      description: meta.description,
      image: meta.image,
      category: item.category,
      paused: false,
      createdAt: new Date().toISOString(),
    } as never)
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 409) return false
    throw err
  }
  // 占位 FeedDoc：首抓成功后会由抓取路径覆盖成解析结果
  try {
    await userDb.get(feedDocId(meta.feedId))
  } catch {
    await userDb.insert({
      _id: feedDocId(meta.feedId),
      type: "feed",
      url: meta.url,
      title: meta.title,
      description: meta.description,
      siteUrl: meta.siteUrl,
      image: meta.image,
      createdAt: new Date().toISOString(),
    } as never).catch(() => {})
  }
  return true
}

/**
 * 读取用户的全部订阅文档（原始形状）。
 *
 * 读失败的区分很重要：404 类错误只可能是"这个用户还没有库"，返回空数组；
 * 其它错误必须抛 —— 一次 CouchDB 抖动被当成"没有订阅"，会让上游把这些源全判成退订。
 */
export async function listSubscriptionDocs(userId: string): Promise<Array<SubscriptionDoc & { kind?: unknown }>> {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const { rows } = await userDb.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  return rows.map((row) => row.doc as SubscriptionDoc & { kind?: unknown }).filter(Boolean)
}

/** 当前用户的订阅 feedId 集合（含 bot 订阅；调用方自己按 `bot:` 前缀区分） */
export async function getSubscribedFeedIds(userId: string): Promise<Set<string>> {
  const docs = await listSubscriptionDocs(userId)
  return new Set(
    docs
      .map((doc) => doc.feedId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )
}

/**
 * 删除当前用户的某个订阅（用户库里的 subscription 文档）。
 *
 * 只删订阅文档：条目由调用方的退订清理按前缀 purge（见 `purgeSubscriptionContent`），
 * `_local/schedule` 里的状态也一并清掉，避免重新订阅时继承旧的 lastFetchedAt。
 */
export async function removeSubscription(userId: string, feedId: string): Promise<boolean> {
  const dbName = await ensureTimelineDatabase(userId)
  const userDb = createCouchDb(dbName)
  const docId = subscriptionDocId(feedId)
  try {
    const doc = await userDb.get(docId) as { _id: string, _rev: string }
    await userDb.destroy(docId, doc._rev)
    await dropSourceSchedule(dbName, feedId)
    return true
  } catch {
    return false
  }
}

/**
 * 暂停/恢复某条订阅的抓取。
 *
 * 写的是订阅文档的 `paused` 字段（客户端可写文档，所以必须读改写 + 409 重试），
 * 同时镜像进 `_local/schedule` —— 调度器每轮读的是 schedule，不必再去解析每个订阅文档。
 *
 * @returns true=已写入；false=该用户没订阅这个源
 */
export async function setSubscriptionPaused(userId: string, feedId: string, paused: boolean): Promise<boolean> {
  const dbName = await ensureTimelineDatabase(userId)
  const userDb = createCouchDb(dbName)
  const docId = subscriptionDocId(feedId)

  for (let attempt = 0; attempt < 5; attempt++) {
    let doc: Record<string, unknown>
    try {
      doc = await userDb.get(docId) as unknown as Record<string, unknown>
    } catch {
      // 读不到 = 没订阅（或订阅文档已失效），不是"更新失败"
      return false
    }
    try {
      await userDb.insert({ ...doc, paused } as never)
      await mergeSourceSchedule(dbName, feedId, { paused })
      return true
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 409) throw err
      // 409：客户端同时改了这条文档，重读重算
    }
  }
  return false
}

/**
 * 用户对**自己这一个订阅**的个性化修改（显示名 / 分组）。
 *
 * 写的是用户库里的 `subscription:{feedId}` 文档，与前端「编辑订阅」弹窗
 * （`usePouchDb.updateSubscription`）完全同源 —— 客户端从用户库读的正是这份 title/category，
 * 所以改完立刻可见。
 *
 * **`url` 不在可改字段里**：它决定抓取目标，改它等于换源；而且改了 url 会让
 * `feedId` 与 url 不再匹配（`parseSubscription` 会拒掉这条订阅）。换源请重新订阅。
 *
 * @returns true=已写入；false=该 feed 不在当前用户的订阅里
 */
export async function updateUserSubscription(
  userId: string,
  feedId: string,
  patch: { title?: string, category?: string },
): Promise<boolean> {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const docId = subscriptionDocId(feedId)
  for (let attempt = 0; attempt < 5; attempt++) {
    let doc: Record<string, any>
    try {
      doc = await userDb.get(docId) as Record<string, any>
    } catch {
      return false
    }
    if (patch.title === undefined && patch.category === undefined) return false
    // 只合入传入的字段：undefined 表示"不动这个字段"，与前端 updateSubscription 的语义一致
    if (patch.title !== undefined) doc.title = patch.title
    if (patch.category !== undefined) doc.category = patch.category
    try {
      await userDb.insert(doc as never)
      return true
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 409) throw err
    }
  }
  return false
}

/**
 * 触发某条订阅立即重新抓取（清空调度里的失败计数并入队）。
 *
 * @returns true=已入队；false=该用户没订阅这个源
 */
export async function refetchFeed(userId: string, feedId: string): Promise<boolean> {
  const docs = await listSubscriptionDocs(userId)
  const doc = docs.find((item) => item.feedId === feedId && item.kind !== "bot")
  if (!doc) return false
  const parsed = parseSubscription(doc)
  if (!parsed.ok) return false

  const dbName = await ensureTimelineDatabase(userId)
  // 清掉失败计数与"刚抓过"的时间，让这一轮立刻入队并真正发请求
  await mergeSourceSchedule(dbName, feedId, { errorStreak: 0, lastFetchedAt: undefined })
  await enqueueOwnerFetch({
    owner: { kind: "user", id: userId },
    feedId: parsed.feedId,
    url: parsed.url,
    title: parsed.title,
    // 立即抓取要真的发一次网络请求：缓存命中会让"点了没反应"变成常态
    bypassCache: true,
  })
  return true
}

/** 当前用户订阅列表（feed + bot），状态来自 `_local/schedule` 与 bots 表 */
export async function listSubscriptionsForUser(userId: string) {
  const dbName = await ensureTimelineDatabase(userId)
  const [docs, schedule] = await Promise.all([
    listSubscriptionDocs(userId),
    readSchedule(dbName).catch(() => null as ScheduleState | null),
  ])

  const feedDocs = docs.filter((doc) => doc.kind !== "bot")
  const botDocs = docs.filter((doc) => doc.kind === "bot")
  const botIds = botDocs
    .map((doc) => String(doc.feedId ?? "").replace(/^bot:/, ""))
    .filter(Boolean)

  const botRegistry = botIds.length
    ? await db.select().from(bots).where(inArray(bots.id, botIds))
    : []
  const botById = new Map(botRegistry.map((bot) => [bot.id, bot]))

  return [
    ...feedDocs.map((doc) => {
      const entry = doc.feedId ? schedule?.sources?.[doc.feedId] : undefined
      const status = doc.paused === true || entry?.paused === true
        ? "paused" as const
        : entry?.lastErrorAt && (entry.errorStreak ?? 0) > 0 ? "error" as const : "active" as const
      return {
        feedId: doc.feedId,
        kind: "feed" as const,
        title: doc.title,
        siteUrl: doc.siteUrl,
        image: doc.image,
        description: doc.description,
        category: doc.category,
        createdAt: doc.createdAt,
        status,
        errorMessage: status === "error" ? lastErrorLabel(entry) : undefined,
        lastFetchedAt: entry?.lastFetchedAt,
        lastNewEntryAt: entry?.lastNewEntryAt,
        // 抓取地址：编辑订阅弹窗只读展示（前端离线时回退本地 FeedDoc）
        feedUrl: doc.url,
      }
    }),
    ...botDocs.map((doc) => {
      const botId = String(doc.feedId ?? "").replace(/^bot:/, "")
      const reg = botById.get(botId)
      return {
        feedId: doc.feedId,
        kind: "bot" as const,
        title: doc.title ?? reg?.name,
        siteUrl: undefined,
        image: doc.image ?? reg?.avatarUrl,
        description: doc.description ?? reg?.description,
        category: doc.category,
        createdAt: doc.createdAt,
        status: reg?.isActive === false ? "paused" as const : "active" as const,
        lastNewEntryAt: reg?.lastNewEntryAt?.toISOString(),
        // bot 没有 RSS 地址：前端用它在编辑订阅弹窗里拼联邦地址 `@用户名@域名`
        preferredUsername: reg?.preferredUsername,
      }
    }),
  ]
}

/**
 * 错误信息。
 *
 * 旧模型里具体错误（超时、404、解析失败）存在 `feeds.error_message`，现在只存了
 * 「上次失败时刻」与连续次数 —— 具体原因随 worker 日志走。
 * 保留这个函数是为了前端 `FeedSubscriptionItem.errorMessage` 字段不出现 "undefined"。
 */
function lastErrorLabel(entry: { lastErrorAt?: string, errorStreak?: number } | undefined): string | undefined {
  if (!entry?.lastErrorAt) return undefined
  const times = entry.errorStreak && entry.errorStreak > 1 ? `（连续 ${entry.errorStreak} 次）` : ""
  return `最近一次抓取失败于 ${new Date(entry.lastErrorAt).toLocaleString()}${times}`
}

/** MCP / 路由用的「订阅一个 URL」组合操作 */
export async function addSubscriptionByUrl(
  userId: string,
  url: string,
  category?: string,
): Promise<{ feedId: string, added: boolean, title: string }> {
  // probe 默认开：单条添加要即时给出标题；解析失败的源也照样订阅（错误由 worker 标记）
  const { meta, added } = await ensureFeedSubscribed(userId, {
    url,
    title: url,
    category,
  })
  void touchTimelineActivity(userId)
  return { feedId: meta.feedId, added, title: meta.title }
}

/** 复用格式错误导出，供 MCP 工具在解析失败时返回可读信息 */
export { formatFeedError }
