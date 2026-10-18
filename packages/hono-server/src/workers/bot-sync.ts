import { Queue, Worker } from "bullmq"
import { eq } from "drizzle-orm"
import { createCouchDb, ensureBotDatabase, ensureFeedDatabase } from "../couchdb/client"
import { db, botFeeds, bots as botsTable } from "../db"
import { connection, createWorkerConnection } from "./connection"
import { envInt } from "../env"

/**
 * Bot 产出复制队列（把源库的条目镜像进引用了该 feed 的 Bot 产出库）。
 *
 * 原先这一步在抓取 job 里同步做，失败时只打一行日志就继续 —— 该条目对 Bot 的订阅者
 * 永久缺失，而下一个轮次通常是 304，再也不会补。现在抽成独立队列：
 *   - 失败有 `attempts` + 指数退避重试；产出 doc `_id` 是确定性的，重试天然幂等
 *     （已写入的条目在重试时会被跳过）；
 *   - 抓取路径不再被 Bot 复制拖慢（Bot 多、附件大时尤其明显）。
 *
 * 没有关联 Bot 的源不会入队（enqueueBotCopy 里先查一下），避免给 700 个源制造空 job。
 */

const BOT_COPY_CONCURRENCY = envInt("BOT_COPY_CONCURRENCY", 2)

export interface BotCopyBot {
  id: string
  name: string
  avatarUrl: string | null
}

export interface BotCopyJobData {
  feedId: string
  /** 关联的 Bot 元信息（抓取时一并查出，重试时直接用，不再查一次 PG） */
  bots: BotCopyBot[]
  /** 要复制的源库条目 doc id；空数组表示只校正 Bot 库里的 FeedDoc 元信息（名字/头像） */
  entryIds: string[]
}

export const botCopyQueue = new Queue("rss-bot-copy", { connection })

const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

export const botCopyWorker = isTestProcess ? null : new Worker<BotCopyJobData>("rss-bot-copy", async (job) => {
  await copyEntriesToBots(job.data)
}, { connection: createWorkerConnection(), concurrency: BOT_COPY_CONCURRENCY })

/** 源库读接口 / 目标库写接口（抽窄是为了单测注入假实现，不必起 CouchDB） */
export interface BotCopySourceDb {
  get(id: string, opts?: { attachments?: boolean }): Promise<any>
}

export interface BotCopyTargetDb {
  get(id: string): Promise<any>
  insert(doc: any): Promise<any>
  multipart: { insert(doc: any, attachments: any[], opts?: any): Promise<any> }
}

/** 产出 doc 的 _id：`entry:bot:{botId}:{hash12}`，与源库 entry 同源 hash（确定性 → 重试幂等） */
export function botOutputId(botId: string, entryId: string): string {
  return `entry:bot:${botId}:${entryId.replace(/^entry:[^:]+:/, "")}`
}

/**
 * 把一条源条目复制进一个 Bot 产出库；已存在返回 false（跳过），写入成功返回 true。
 * 失败直接抛出，由调用方决定是重试整批还是继续下一条。
 */
export async function copyEntryToBotDb(
  botId: string,
  entryId: string,
  feedDb: BotCopySourceDb,
  botDb: BotCopyTargetDb,
): Promise<boolean> {
  const outputId = botOutputId(botId, entryId)
  try {
    await botDb.get(outputId)
    return false // 已存在：重试路径会大量走到这里
  } catch {
    // 不存在，继续写入
  }
  // 附件随 doc 读取（base64）后 multipart 写入，产出 doc 离线也能看图
  const doc = await feedDb.get(entryId, { attachments: true })
  const { _rev: _omit, _attachments: _omitAtt, ...rest } = doc
  const outputDoc = { ...rest, _id: outputId, feedId: `bot:${botId}` }
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
  return true
}

/** 确保 bot 产出库存在 FeedDoc（_id 为虚拟 feed id `bot:{botId}`），供时间线补全 bot 名字/头像 */
async function ensureBotFeedDoc(botDb: BotCopyTargetDb, botId: string, name: string, avatarUrl: string | null) {
  const docId = `bot:${botId}`
  try {
    const existing = await botDb.get(docId) as any
    // 名字/头像变化时同步更新（每次抓取都会校正）
    if (existing.title !== name || existing.image !== avatarUrl) {
      await botDb.insert({ ...existing, title: name, image: avatarUrl ?? undefined })
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
    })
  }
}

/**
 * 执行一次复制：逐 Bot 校正 FeedDoc、复制条目。
 *
 * 单条失败不中断同批其他条目（记日志继续），最后若有失败则抛出让队列重试 ——
 * 重试时已写成功的条目会被 `copyEntryToBotDb` 跳过。
 */
export async function copyEntriesToBots(data: BotCopyJobData): Promise<void> {
  const { feedId, bots, entryIds } = data
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId)) as unknown as BotCopySourceDb
  const failures: string[] = []
  for (const bot of bots) {
    const botDb = createCouchDb(await ensureBotDatabase(bot.id)) as unknown as BotCopyTargetDb
    await ensureBotFeedDoc(botDb, bot.id, bot.name, bot.avatarUrl)
    let published = 0
    for (const entryId of entryIds) {
      try {
        if (await copyEntryToBotDb(bot.id, entryId, feedDb, botDb)) published++
      } catch (err) {
        failures.push(`${bot.id}/${entryId}: ${(err as Error)?.message ?? err}`)
        console.warn(`[Bot] 产出写入失败 ${bot.id}/${entryId}:`, (err as Error)?.message ?? err)
      }
    }
    if (published > 0) {
      // touch 最后产出时间，供前端增量同步判断
      await db.update(botsTable).set({ lastNewEntryAt: new Date() }).where(eq(botsTable.id, bot.id))
    }
  }
  if (failures.length > 0) throw new Error(`bot 产出复制失败 ${failures.length} 条（将自动重试）`)
}

/** 查该源关联的 Bot 并入队一次复制；没有关联 Bot 时直接返回（不产生空 job） */
export async function enqueueBotCopy(feedId: string, entryIds: string[]): Promise<void> {
  const bots = await db.select({
    id: botFeeds.botId,
    name: botsTable.name,
    avatarUrl: botsTable.avatarUrl,
  })
    .from(botFeeds)
    .innerJoin(botsTable, eq(botsTable.id, botFeeds.botId))
    .where(eq(botFeeds.feedId, feedId))
  if (bots.length === 0) return
  await botCopyQueue.add(`bot-copy:${feedId}`, { feedId, bots, entryIds } satisfies BotCopyJobData, {
    // 产出失败多半是 CouchDB 抖动/并发冲突：指数退避重试 5 次，最终失败保留在队列里供看板排查
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  })
}

/** 关闭队列与 worker（shutdownWorkers 调用；测试进程里 worker 为 null） */
export async function shutdownBotCopyWorkers(): Promise<void> {
  await botCopyWorker?.close()
  await botCopyQueue.close()
}
