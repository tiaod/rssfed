import { Worker, Queue } from "bullmq"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { ensureFeedDatabase, createCouchDb } from "../couchdb/client"
import { parseFeedUrl, formatFeedError, type ParsedFeed, type ParsedItem } from "../rss/parser"
import { cacheEntryImages, cacheSingleImage } from "../rss/entry-images"
import { db, feeds, botFeeds, botOutbox, type EntryDoc, type NewBotOutbox } from "../db"

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

export const fetchQueue = new Queue("rss-fetch", { connection })

type FeedDb = ReturnType<typeof createCouchDb>

export const worker = new Worker("rss-fetch", async (job) => {
  const { feedId, url } = job.data

  try {
    const parsed = await parseFeedUrl(url)
    const feedDb = createCouchDb(await ensureFeedDatabase(feedId))

    // 依次更新 FeedDoc 元数据、PostgreSQL 注册表，再写入新条目并通知相关 Bot
    const iconCached = await updateFeedDoc(feedDb, feedId, url, parsed)
    await updateFeedRegistry(feedId, url, parsed)
    const newEntries = await insertNewEntries(feedDb, feedId, parsed.items ?? [])
    // 抓到新条目时记录时间，供前端增量同步判断（只同步有新内容的源）
    if (newEntries.length > 0) {
      await db.update(feeds).set({ lastNewEntryAt: new Date() }).where(eq(feeds.id, feedId))
    } else if (iconCached) {
      // 无新条目但首次缓存了 feed 图标：同样 touch，让前端同步拉取图标附件
      await db.update(feeds).set({ lastNewEntryAt: new Date() }).where(eq(feeds.id, feedId))
    }
    await notifyRelatedBots(feedId, newEntries)

    return { feedId, newEntries: newEntries.length, totalItems: parsed.items?.length ?? 0 }
  } catch (err) {
    // 抓取失败，更新 feed 注册表的 errorMessage
    await markFeedError(feedId, url, err)
    throw err
  }
}, { connection })

/** 更新（或首次创建）CouchDB 中的 FeedDoc 元数据；返回是否首次缓存了图标（用于触发前端同步） */
async function updateFeedDoc(feedDb: FeedDb, feedId: string, url: string, parsed: ParsedFeed): Promise<boolean> {
  const imageUrl = parsed.image?.url
  try {
    const existing = await feedDb.get(feedId) as any
    const doc = {
      ...existing,
      title: parsed.title ?? existing.title,
      description: parsed.description ?? existing.description,
      siteUrl: parsed.link ?? existing.siteUrl,
      image: imageUrl ?? existing.image,
      lastFetchedAt: new Date().toISOString(),
      errorMessage: undefined,
    }
    // feed 图标缓存：URL 变化（或首次有图标）时下载压缩为 AVIF 附件；失败静默跳过
    if (imageUrl && imageUrl !== existing.imageCached?.url) {
      const cached = await cacheSingleImage(imageUrl)
      if (cached) {
        await feedDb.multipart.insert({ ...doc, imageCached: cached.image } as any,
          [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }],
          { docName: feedId, rev: existing._rev })
        return true // 图标首次缓存：touch lastNewEntryAt，触发前端同步拉取附件
      }
    }
    await feedDb.insert(doc as any)
  } catch {
    // FeedDoc 不存在，首次插入
    const doc: any = {
      _id: feedId,
      type: "feed",
      url,
      title: parsed.title ?? url,
      description: parsed.description,
      siteUrl: parsed.link,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
    // 首次建库时也尝试缓存图标（用原 URL 作为 imageCached 判断基准：首次无缓存）
    if (imageUrl) {
      const cached = await cacheSingleImage(imageUrl)
      if (cached) {
        doc.image = imageUrl
        doc.imageCached = cached.image
        await feedDb.multipart.insert(doc, [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }], { docName: feedId })
        return true
      }
    }
    await feedDb.insert(doc)
  }
  return false
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
async function insertNewEntries(feedDb: FeedDb, feedId: string, items: ParsedItem[]) {
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
    // 下载并压缩正文图片为 AVIF 附件，与条目一次写入（multipart）；
    // 协议封面（media:thumbnail/图片 enclosure）优先作为封面，正文图回退；
    // 图片缓存失败不阻塞抓取，回退为无图条目（前端保留原 URL 直链）
    try {
      const { attachments, images } = await cacheEntryImages(entry.content, entry.url, item.coverUrl)
      if (images.length > 0) {
        // nano 的 multipart.insert 需在 params 中显式传入 docName
        await feedDb.multipart.insert({ ...entry, images } as any, attachments, { docName: entryId })
        newEntries.push(entry)
        continue
      }
    } catch (err) {
      console.warn(`[EntryImages] 图片缓存失败，回退原始条目 ${entryId}:`, err)
    }
    await feedDb.insert(entry as any)
    newEntries.push(entry)
  }
  return newEntries
}

/** 由 RSS item 构造 EntryDoc */
function buildEntry(feedId: string, item: ParsedItem, guid: string, entryId: string): EntryDoc {
  return {
    _id: entryId,
    type: "entry",
    feedId,
    url: item.link ?? "",
    title: item.title ?? "",
    content: item.content ?? item.contentSnippet,
    description: item.summary ?? item.contentSnippet,
    guid,
    author: item.creator,
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
    // jobId 固定为 feedId：同一 feed 已在排队/执行时跳过，避免抓取慢时任务堆积
    // （BullMQ 不允许 jobId 含冒号，故用纯 feedId）
    opts: { jobId: f.id },
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
