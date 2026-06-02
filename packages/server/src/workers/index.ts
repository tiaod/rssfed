import { Worker, Queue } from "bullmq"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { nanoServer } from "../couchdb/client"
import { rssParser } from "../rss/parser"
import { COUCHDB_GLOBAL, type FeedDoc, type EntryDoc } from "../db"

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

export const fetchQueue = new Queue("rss-fetch", { connection })

export const worker = new Worker("rss-fetch", async (job) => {
  const { feedId, url } = job.data

  try {
    const feed = await rssParser.parseURL(url)
    const db = nanoServer.use(COUCHDB_GLOBAL)

    try {
      const existing = await db.get(feedId) as FeedDoc
      await db.insert({
        ...existing,
        title: feed.title ?? existing.title,
        description: feed.description ?? existing.description,
        siteUrl: feed.link ?? existing.siteUrl,
        image: feed.image?.url ?? existing.image,
        lastFetchedAt: new Date().toISOString(),
        errorMessage: undefined,
      } as any)
    } catch {
    }

    let newCount = 0
    for (const item of feed.items ?? []) {
      const guid = item.guid ?? item.link ?? item.title ?? ""
      const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`

      try {
        await db.get(entryId)
        continue
      } catch {
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

      await db.insert(entry as any)
      newCount++
    }

    return { feedId, newEntries: newCount, totalItems: feed.items?.length ?? 0 }
  } catch (err) {
    try {
      const db = nanoServer.use(COUCHDB_GLOBAL)
      const existing = await db.get(feedId) as FeedDoc
      await db.insert({
        ...existing,
        errorMessage: String(err),
        lastFetchedAt: new Date().toISOString(),
      } as any)
    } catch {
    }

    throw err
  }
}, { connection })

export async function scheduleFeedFetches() {
  const db = nanoServer.use(COUCHDB_GLOBAL)
  const result = await db.view("main", "feeds-all")

  const jobs = result.rows
    .filter(row => row.value)
    .map(row => ({
      name: `fetch:${row.key}`,
      data: { feedId: row.key, url: (row.value as any).url },
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