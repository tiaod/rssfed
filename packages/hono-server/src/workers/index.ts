import { Worker, Queue } from "bullmq"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { ensureFeedDatabase, ensureBotDatabase, createCouchDb } from "../couchdb/client"
import { parseFeedUrl, formatFeedError, type ParsedFeed, type ParsedItem } from "../rss/parser"
import { cacheEntryImages, cacheSingleImage, type EntryImageOptions } from "../rss/entry-images"
import { db, feeds, botFeeds, bots as botsTable, type EntryDoc } from "../db"

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
    // 无论有无新条目都同步相关 Bot：FeedDoc 元信息需在无新条目时也能校正
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
  // 读取该 feed 的 per-feed 图片缓存策略（管理员可覆盖全局默认，未设置则走全局默认）
  const imageOptions = await resolveFeedImageOptions(feedId)
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
      const { attachments, images } = await cacheEntryImages(entry.content, entry.url, item.coverUrl, imageOptions)
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

/** 从 feeds 表读取该 feed 的 per-feed 图片缓存配置（仅返回设置过的字段，其余走全局默认） */
async function resolveFeedImageOptions(feedId: string): Promise<EntryImageOptions> {
  try {
    const [feed] = await db.select({
      cacheImages: feeds.cacheImages,
      maxImageCount: feeds.maxImageCount,
      maxImageWidth: feeds.maxImageWidth,
      avifQuality: feeds.avifQuality,
      maxSourceImageBytes: feeds.maxSourceImageBytes,
    }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
    if (!feed) return {}
    return {
      cacheAll: feed.cacheImages ?? false,
      maxImageCount: feed.maxImageCount ?? undefined,
      maxImageWidth: feed.maxImageWidth ?? undefined,
      avifQuality: feed.avifQuality ?? undefined,
      maxSourceImageBytes: feed.maxSourceImageBytes ?? undefined,
    }
  } catch {
    // 读取配置失败不影响抓取，走全局默认
    return {}
  }
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

/** 将新条目以「原文镜像」写入引用了该 feed 的 Bot 的产出库（_id 确定性天然幂等） */
async function notifyRelatedBots(feedId: string, newEntries: EntryDoc[]) {
  const relatedBots = await db.select({
    id: botFeeds.botId,
    name: botsTable.name,
    avatarUrl: botsTable.avatarUrl,
  })
    .from(botFeeds)
    .innerJoin(botsTable, eq(botsTable.id, botFeeds.botId))
    .where(eq(botFeeds.feedId, feedId))
  if (relatedBots.length === 0) return
  console.log(`[Bot] notifyRelatedBots: ${relatedBots.length} bot(s) for feed ${feedId}, newEntries=${newEntries.length}`)

  // 从 feed 库读 entry（含图片附件二进制）复制到各 bot 产出库，避免重复下载压缩图片
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  for (const bot of relatedBots) {
    const botDb = createCouchDb(await ensureBotDatabase(bot.id))
    await ensureBotFeedDoc(botDb, bot.id, bot.name, bot.avatarUrl)
    let published = 0
    for (const entry of newEntries) {
      // 产出 doc _id：entry:bot:{botId}:{hash12}，与 feed 库 entry 同源 hash，冲突即已写入
      const outputId = `entry:bot:${bot.id}:${entry._id.replace(/^entry:[^:]+:/, "")}`
      try {
        await botDb.get(outputId)
        continue // 已存在，跳过
      } catch {
        // 不存在，继续写入
      }
      try {
        // 附件随 doc 读取（base64）后 multipart 写入，产出 doc 离线也能看图
        const doc = await feedDb.get(entry._id, { attachments: true }) as any
        const { _rev: _omit, _attachments: _omitAtt, ...rest } = doc
        const outputDoc = { ...rest, _id: outputId, feedId: `bot:${bot.id}` }
        if (doc._attachments) {
          const attachments = Object.entries(doc._attachments).map(([name, att]: [string, any]) => ({
            name,
            data: Buffer.from(att.data, "base64"),
            content_type: att.content_type,
          }))
          await botDb.multipart.insert(outputDoc, attachments, { docName: outputId })
        } else {
          await botDb.insert(outputDoc)
        }
        published++
      } catch (err) {
        // 写入失败（含并发 409 冲突）不阻塞抓取，记日志继续
        console.warn(`[Bot] 产出写入失败 ${bot.id}/${entry._id}:`, (err as any)?.message ?? err)
      }
    }
    if (published > 0) {
      // touch 最后产出时间，供前端增量同步判断
      await db.update(botsTable).set({ lastNewEntryAt: new Date() }).where(eq(botsTable.id, bot.id))
    }
  }
}

/** 确保 bot 产出库存在 FeedDoc（_id 为虚拟 feed id `bot:{botId}`），供时间线补全 bot 名字/头像 */
async function ensureBotFeedDoc(botDb: FeedDb, botId: string, name: string, avatarUrl: string | null) {
  const docId = `bot:${botId}`
  try {
    const existing = await botDb.get(docId) as any
    // 名字/头像变化时同步更新（每次抓取都会校正）
    if (existing.title !== name || existing.image !== avatarUrl) {
      await botDb.insert({ ...existing, title: name, image: avatarUrl ?? undefined } as any)
    }
  } catch {
    await botDb.insert({
      _id: docId,
      type: "feed",
      url: "",
      title: name,
      image: avatarUrl ?? undefined,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as any)
  }
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
    // 任务结果保留有限条数供看板（/admin/queues）查看；入队前会清掉已结束的旧 job，
    // 因此 jobId 不会因残留被 BullMQ 判定 duplicated 拒绝（曾导致 21 小时无抓取）
    opts: { jobId: f.id, removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } },
    data: { feedId: f.id, url: f.url },
  }))

  if (jobs.length > 0) {
    // 先清理各 feed 已结束（完成/失败）的旧 job，确保 jobId 可复用；
    // 执行中/排队中的 job 不动，避免打断在跑的任务
    await Promise.all(allFeeds.map(f => removeFinishedJob(f.id)))
    await fetchQueue.addBulk(jobs)
  }
}

/** 清理 feed 已结束的旧 job（completed/failed）；active/waiting 等未结束的不动 */
async function removeFinishedJob(feedId: string) {
  const job = await fetchQueue.getJob(feedId)
  if (!job) return
  const state = await job.getState()
  if (state === "completed" || state === "failed") {
    await job.remove()
  }
}

/** 入队一次抓取（单 feed 场景）：先清理旧 job 再入队，与调度器逻辑一致 */
export async function enqueueFetch(feedId: string, url: string) {
  await removeFinishedJob(feedId)
  await fetchQueue.add(`fetch:${feedId}`, { feedId, url }, {
    jobId: feedId,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  })
}

const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL ?? "900000")
const fetchInterval = setInterval(scheduleFeedFetches, FETCH_INTERVAL)

export async function shutdownWorkers() {
  clearInterval(fetchInterval)
  await worker.close()
  await fetchQueue.close()
  await connection.quit()
}
