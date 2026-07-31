import { Worker, Queue } from "bullmq"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { ensureFeedDatabase, createCouchDb, feedDbName } from "../couchdb/client"
import { rssParser } from "../rss/parser"
import { db, feeds, botFeeds, botOutbox, type EntryDoc, type NewBotOutbox } from "../db"

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

export const fetchQueue = new Queue("rss-fetch", { connection })

export const worker = new Worker("rss-fetch", async (job) => {
  const { feedId, url } = job.data

  try {
    // 确保 per-feed CouchDB 库存在
    await ensureFeedDatabase(feedId)
    const feedDb = createCouchDb(feedDbName(feedId))

    const parsed = await rssParser.parseURL(url)

    // 更新 FeedDoc 元数据
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

    // 更新 PostgreSQL feed 注册表
    await db.update(feeds).set({
      title: parsed.title ?? url,
      description: parsed.description,
      siteUrl: parsed.link,
      errorMessage: undefined,
      lastFetchedAt: new Date(),
    }).where(eq(feeds.id, feedId))

    // 写入新条目到 per-feed CouchDB 库
    const newEntries: EntryDoc[] = []
    for (const item of parsed.items ?? []) {
      const guid = item.guid ?? item.link ?? item.title ?? ""
      const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`

      try {
        await feedDb.get(entryId)
        continue // 已存在，跳过
      } catch {
        // 不存在，继续写入
      }

      const entry: EntryDoc = {
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

      await feedDb.insert(entry as any)
      newEntries.push(entry)
    }

    // 如果有新条目，写入引用了该 feed 的 Bot 的 outbox
    if (newEntries.length > 0) {
      const relatedBots = await db.select({ botId: botFeeds.botId })
        .from(botFeeds)
        .where(eq(botFeeds.feedId, feedId))

      if (relatedBots.length > 0) {
        const outboxEntries: NewBotOutbox[] = []
        for (const entry of newEntries) {
          for (const { botId } of relatedBots) {
            outboxEntries.push({
              id: `${botId}:${entry._id}`,
              botId,
              entryId: entry._id!,
              feedId,
              title: entry.title,
              url: entry.url,
              publishedAt: new Date(entry.publishedAt),
            })
          }
        }
        // 批量写入，冲突跳过（已有记录的不重复写入）
        for (const out of outboxEntries) {
          await db.insert(botOutbox).values(out).onConflictDoNothing()
        }
      }
    }

    return { feedId, newEntries: newEntries.length, totalItems: parsed.items?.length ?? 0 }
  } catch (err) {
    // 抓取失败，更新 feed 注册表的 errorMessage
    await db.update(feeds).set({
      errorMessage: String(err),
      lastFetchedAt: new Date(),
    }).where(eq(feeds.id, feedId))

    throw err
  }
}, { connection })

/** 定时调度所有已知 feed 的抓取任务 */
export async function scheduleFeedFetches() {
  const allFeeds = await db.select({ id: feeds.id, url: feeds.url })
    .from(feeds)

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
