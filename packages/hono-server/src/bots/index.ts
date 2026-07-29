import { createInstance, text } from "@fedify/botkit"
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis"
import IORedis from "ioredis"
import { db, bots as botsTable, botFeeds, type EntryDoc, COUCHDB_GLOBAL } from "../db"
import { eq } from "drizzle-orm"
import { createCouchDb } from "../couchdb/client"

const origin = process.env.BOTS_BASE_URL ?? "http://localhost:3001"
const pollIntervalMs = parseInt(process.env.CHECK_INTERVAL ?? "300000")
const globalDb = createCouchDb(COUCHDB_GLOBAL)

// 共享 Redis 连接（BotKit KV + 消息队列共用）
const redis = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
})

// 创建 BotKit Instance，可托管多个动态 Bot
// BotKit 内部使用 Fedify，自动处理 Actor 分发、Inbox 路由等
const instance = createInstance<void>({
  kv: new RedisKvStore(redis),
  queue: new RedisMessageQueue(() => redis),
  behindProxy: true,
})

// 动态 Bot 组 — Bot 数据来源于 PostgreSQL bots
// 每个 Bot 的 preferredUsername 作为 ActivityPub 标识（@botname@domain）
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

// BotKit 自动处理 Follow 请求的 Accept 响应
bots.onFollow = async (_session, followRequest) => {
  await followRequest.accept()
}

// ── RSS 发布轮询 ──
// 用 Set 追踪已发布条目避免重复；重启后首次轮询建立基线

const published = new Set<string>()
let baselined = false

async function pollFeeds() {
  // 第一步：首次运行建立基线，记录已有条目但不发布
  if (!baselined) {
    const activeBots = await db.select().from(botsTable)
      .where(eq(botsTable.isActive, true))
    for (const bot of activeBots) {
      const feedLinks = await db.select({ feedId: botFeeds.feedId })
        .from(botFeeds)
        .where(eq(botFeeds.botId, bot.id))
      for (const { feedId } of feedLinks) {
        const result = await globalDb.view("main", "entries-by-feed", {
          key: feedId,
          limit: 50,
        })
        for (const row of result.rows) {
          const entry = (row as any).value as { _id: string } | undefined
          if (entry?._id) published.add(`${bot.id}:${entry._id}`)
        }
      }
    }
    baselined = true
    console.log(`BotKit baseline: ${published.size} entries tracked`)
    return
  }

  // 第二步：轮询新条目，用 BotKit Session.publish() 推送到所有关注者
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))

  for (const bot of activeBots) {
    const feedLinks = await db.select({ feedId: botFeeds.feedId })
      .from(botFeeds)
      .where(eq(botFeeds.botId, bot.id))
    if (feedLinks.length === 0) continue

    const feedIds = feedLinks.map(f => f.feedId)
    let count = 0

    const session = await bots.getSession(origin, bot.preferredUsername)

    for (const feedId of feedIds) {
      const result = await globalDb.view("main", "entries-by-feed", {
        key: feedId,
        limit: 10,
      })
      for (const row of result.rows) {
        const entry = (row as any).value as { _id: string } | undefined
        if (!entry?._id) continue
        const key = `${bot.id}:${entry._id}`
        if (published.has(key)) continue

        const doc = await globalDb.get(entry._id) as unknown as EntryDoc
        const content = doc.url ? `${doc.title}\n${doc.url}` : doc.title

        await session.publish(text`${content}`)
        published.add(key)
        count++
      }
    }

    if (count > 0) {
      console.log(`Bot ${bot.preferredUsername}: published ${count} new entry(s)`)
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
