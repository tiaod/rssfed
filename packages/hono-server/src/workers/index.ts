import { Worker, Queue } from "bullmq"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { ensureFeedDatabase, createCouchDb } from "../couchdb/client"
import { rssParser, formatFeedError } from "../rss/parser"
import { db, feeds, botFeeds, botOutbox, type EntryDoc, type NewBotOutbox } from "../db"

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

export const fetchQueue = new Queue("rss-fetch", { connection })

type ParsedFeed = Awaited<ReturnType<typeof rssParser.parseURL>>
type FeedDb = ReturnType<typeof createCouchDb>

export const worker = new Worker("rss-fetch", async (job) => {
  const { feedId, url } = job.data

  try {
    const parsed = await rssParser.parseURL(url)
    const feedDb = createCouchDb(await ensureFeedDatabase(feedId))

    // 依次更新 FeedDoc 元数据、PostgreSQL 注册表，再写入新条目并通知相关 Bot
    await updateFeedDoc(feedDb, feedId, url, parsed)
    await updateFeedRegistry(feedId, url, parsed)
    const newEntries = await insertNewEntries(feedDb, feedId, parsed.items ?? [])
    await notifyRelatedBots(feedId, newEntries)

    return { feedId, newEntries: newEntries.length, totalItems: parsed.items?.length ?? 0 }
  } catch (err) {
    // 抓取失败，更新 feed 注册表的 errorMessage
    await markFeedError(feedId, url, err)
    throw err
  }
}, { connection })

/** 更新（或首次创建）CouchDB 中的 FeedDoc 元数据 */
async function updateFeedDoc(feedDb: FeedDb, feedId: string, url: string, parsed: ParsedFeed) {
  try {
    const existing = await feedDb.get(feedId) as any
    await feedDb.insert({
      ...existing,
      title: parsed.title ?? existing.title,
      description: parsed.description ?? existing.description,
      siteUrl: parsed.link ?? existing.siteUrl,
      image: parsed.image?.url ?? existing.image,
      lastFetchedAt: new Date().toISOString(),
      errorMessage: undefined,
    } as any)
  } catch {
    // FeedDoc 不存在，首次插入
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
  }
}

/** 更新 PostgreSQL feed 注册表 */
async function updateFeedRegistry(feedId: string, url: string, parsed: ParsedFeed) {
  await db.update(feeds).set({
    title: parsed.title ?? url,
    description: parsed.description,
    siteUrl: parsed.link,
    errorMessage: undefined,
    lastFetchedAt: new Date(),
  }).where(eq(feeds.id, feedId))
}

/** 写入新条目到 per-feed CouchDB 库，返回本次新增的条目列表 */
async function insertNewEntries(feedDb: FeedDb, feedId: string, items: ParsedFeed["items"]) {
  const newEntries: EntryDoc[] = []
  for (const item of items) {
    const guid = item.guid ?? item.link ?? item.title ?? ""
    const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`

    // 已存在则跳过
    try {
      await feedDb.get(entryId)
      continue
    } catch {
      // 不存在，继续写入
    }

    const entry = buildEntry(feedId, item, guid, entryId)
    await feedDb.insert(entry as any)
    newEntries.push(entry)
  }
  return newEntries
}

/** 由 RSS item 构造 EntryDoc */
function buildEntry(feedId: string, item: ParsedFeed["items"][number], guid: string, entryId: string): EntryDoc {
  return {
    _id: entryId,
    type: "entry",
    feedId,
    url: item.link ?? "",
    title: item.title ?? "",
    content: item.content ?? item.contentSnippet,
    description: item.summary ?? item.contentSnippet,
    guid,
    author: item.creator ?? item.author,
    publishedAt: item.pubDate ?? item.isoDate ?? new Date().toISOString(),
    insertedAt: new Date().toISOString(),
    categories: item.categories,
  }
}

/** 将新条目写入引用了该 feed 的 Bot 的 outbox（冲突跳过，不重复写入） */
async function notifyRelatedBots(feedId: string, newEntries: EntryDoc[]) {
  if (newEntries.length === 0) return

  const relatedBots = await db.select({ botId: botFeeds.botId })
    .from(botFeeds)
    .where(eq(botFeeds.feedId, feedId))
  if (relatedBots.length === 0) return

  // 为每个 Bot × 每条新条目生成 outbox 记录，一次批量插入
  const outboxEntries: NewBotOutbox[] = relatedBots.flatMap(({ botId }) =>
    newEntries.map(entry => ({
      id: `${botId}:${entry._id}`,
      botId,
      entryId: entry._id,
      feedId,
      title: entry.title,
      url: entry.url,
      publishedAt: new Date(entry.publishedAt),
    }))
  )
  await db.insert(botOutbox).values(outboxEntries).onConflictDoNothing()
}

/** 抓取失败时记录错误到 feed 注册表 */
async function markFeedError(feedId: string, url: string, err: unknown) {
  await db.update(feeds).set({
    errorMessage: formatFeedError(url, err),
    lastFetchedAt: new Date(),
  }).where(eq(feeds.id, feedId))
}

/** 定时调度所有已知 feed 的抓取任务（跳过用户暂停的源） */
export async function scheduleFeedFetches() {
  const allFeeds = await db.select({ id: feeds.id, url: feeds.url, status: feeds.status })
    .from(feeds)
    .where(eq(feeds.status, "active"))

  const jobs = allFeeds.map(f => ({
    name: `fetch:${f.id}`,
    data: { feedId: f.id, url: f.url },
  }))

  if (jobs.length > 0) {
    await fetchQueue.addBulk(jobs)
  }
}

const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL ?? "900000")
const fetchInterval = setInterval(scheduleFeedFetches, FETCH_INTERVAL)

export async function shutdownWorkers() {
  clearInterval(fetchInterval)
  await worker.close()
  await fetchQueue.close()
  await connection.quit()
}
