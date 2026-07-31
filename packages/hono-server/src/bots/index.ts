import { createInstance, text } from "@fedify/botkit"
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis"
import IORedis from "ioredis"
import { db, bots as botsTable, botFeeds, botOutbox, type EntryDoc } from "../db"
import { eq } from "drizzle-orm"
import { createCouchDb, feedDbName } from "../couchdb/client"

const origin = process.env.BOTS_BASE_URL ?? "http://localhost:3001"
const pollIntervalMs = parseInt(process.env.CHECK_INTERVAL ?? "300000")

// 共享 Redis 连接（BotKit KV + 消息队列共用）
const redis = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
})

// 创建 BotKit Instance
const instance = createInstance<void>({
  kv: new RedisKvStore(redis),
  queue: new RedisMessageQueue(() => redis),
  behindProxy: true,
})

// 动态 Bot 组
const bots = instance.createBot(async (_ctx, identifier) => {
  const [bot] = await db.select().from(botsTable)
    .where(eq(botsTable.preferredUsername, identifier))
    .limit(1)
  if (!bot || !bot.isActive) return null
  return {
    username: bot.preferredUsername,
    name: bot.name ?? bot.preferredUsername,
    summary: bot.description ? text`${bot.description}` : undefined,
  }
})

bots.onFollow = async (_session, followRequest) => {
  await followRequest.accept()
}

// ── RSS 发布轮询 ──

const published = new Set<string>()
let baselined = false

async function pollFeeds() {
  // 第一步：首次运行建立基线
  if (!baselined) {
    const activeBots = await db.select().from(botsTable)
      .where(eq(botsTable.isActive, true))
    for (const bot of activeBots) {
      const feedLinks = await db.select({ feedId: botFeeds.feedId })
        .from(botFeeds)
        .where(eq(botFeeds.botId, bot.id))
      for (const { feedId } of feedLinks) {
        const feedDb = createCouchDb(feedDbName(feedId))
        try {
          const result = await feedDb.view("main", "entries-by-date", {
            limit: 50,
          })
          for (const row of result.rows) {
            const val = row.value as { _id: string } | undefined
            if (val?._id) published.add(`${bot.id}:${val._id}`)
          }
        } catch {
          // feed 库可能还不存在
        }
      }
    }
    baselined = true
    console.log(`BotKit baseline: ${published.size} entries tracked`)
    return
  }

  // 第二步：轮询新条目并发布
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))

  for (const bot of activeBots) {
    const feedLinks = await db.select({ feedId: botFeeds.feedId })
      .from(botFeeds)
      .where(eq(botFeeds.botId, bot.id))
    if (feedLinks.length === 0) continue

    const session = await bots.getSession(origin, bot.preferredUsername)
    let botCount = 0

    for (const { feedId } of feedLinks) {
      const feedDb = createCouchDb(feedDbName(feedId))
      let count = 0

      try {
        const result = await feedDb.view("main", "entries-by-date", {
          limit: 10,
        })

        for (const row of result.rows) {
          const val = row.value as { _id: string } | undefined
          if (!val?._id) continue
          const key = `${bot.id}:${val._id}`
          if (published.has(key)) continue

          const doc = await feedDb.get(val._id) as unknown as EntryDoc
          const content = doc.url ? `${doc.title}\n${doc.url}` : doc.title

          // 发布到 ActivityPub
          const activity = await session.publish(text`${content}`)

          // 记录 activityId 到 bot_outbox
          const activityId = activity?.id?.toString?.() ?? activity?.id?.href ?? null
          if (activityId) {
            await db.update(botOutbox)
              .set({ activityId: String(activityId) })
              .where(eq(botOutbox.entryId, val._id))
          }

          published.add(key)
          count++
        }
      } catch {
        // feed 库不存在或无条目
      }

      if (count > 0) {
        console.log(`Bot ${bot.preferredUsername}: ${count} new entry(s) from ${feedId}`)
      }
      botCount += count
    }

    if (botCount > 0) {
      console.log(`Bot ${bot.preferredUsername}: total ${botCount} new entry(s) published`)
    }
  }
}

let running = false
async function pollOnce() {
  if (running) return
  running = true
  try {
    await pollFeeds()
  } catch (err) {
    console.error("BotKit poll failed:", err)
  } finally {
    running = false
  }
}

pollOnce()
setInterval(pollOnce, pollIntervalMs)

export function shutdownBots() {
  return redis.quit()
}

export { instance }
