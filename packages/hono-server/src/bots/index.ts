import { createInstance, text } from "@fedify/botkit"
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis"
import IORedis from "ioredis"
import crypto from "node:crypto"
import { db, bots as botsTable, botFeeds, botOutbox, botFollowing, botInbox, type EntryDoc } from "../db"
import { and, eq, or } from "drizzle-orm"
import { createCouchDb, ensureFeedDatabase } from "../couchdb/client"

const origin = process.env.BOTS_BASE_URL ?? "http://localhost:3001"
const pollIntervalMs = parseInt(process.env.CHECK_INTERVAL ?? "300000")

// Redis 连接配置（KV 存储与消息队列共用配置，但必须使用独立连接）
const redisOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}

// BotKit KV 存储连接
const redis = new IORedis(redisOptions)

// 消息队列订阅者连接：进入 pub/sub 模式后无法执行普通命令，
// 因此 RedisMessageQueue 的工厂必须每次返回新连接，不能复用 redis
const redisConnections = new Set<IORedis>()
function createRedisConnection() {
  const conn = new IORedis(redisOptions)
  redisConnections.add(conn)
  conn.on("close", () => redisConnections.delete(conn))
  return conn
}

// 创建 BotKit Instance
const instance = createInstance<void>({
  kv: new RedisKvStore(redis),
  queue: new RedisMessageQueue(createRedisConnection),
  behindProxy: true,
})

// 动态 Bot 组
const bots = instance.createBot(async (_ctx, identifier) => {
  const bot = await findBotByUsername(identifier)
  if (!bot || !bot.isActive) return null
  return {
    username: bot.preferredUsername,
    name: bot.name ?? bot.preferredUsername,
    summary: bot.description ? text`${bot.description}` : undefined,
    // 头像：S3 公开 URL（或手填外链），供 ActivityPub actor 的 icon 字段对外展示
    icon: bot.avatarUrl ? new URL(bot.avatarUrl) : undefined,
  }
})

bots.onFollow = async (_session, followRequest) => {
  await followRequest.accept()
}

// ── 出站关注（bot 关注其他联邦宇宙用户）──

/** 从 Bot 的 preferredUsername 反查 bot 行（动态 Bot 组的 identifier 即 preferredUsername） */
async function findBotByUsername(preferredUsername: string) {
  const [bot] = await db.select().from(botsTable)
    .where(eq(botsTable.preferredUsername, preferredUsername))
    .limit(1)
  return bot ?? null
}

/** 查询 Bot 并校验其处于启用状态，否则抛错 */
async function getActiveBot(botId: string) {
  const [bot] = await db.select().from(botsTable).where(eq(botsTable.id, botId)).limit(1)
  if (!bot || !bot.isActive) throw new Error("bot not found or inactive")
  return bot
}

/** 将 actor 的 name / preferredUsername 归一化为可读的显示名 */
function actorDisplayName(actor: { name?: unknown; preferredUsername?: unknown }): string | null {
  const raw = actor.name ?? actor.preferredUsername
  if (raw == null) return null
  const s = String(raw).trim()
  return s || null
}

/** 根据 actor 推导联邦宇宙句柄，如 @alice@mastodon.social */
function actorHandleOf(actor: { preferredUsername?: unknown; id?: URL | null }): string | null {
  const host = actor.id?.hostname
  if (!host || actor.preferredUsername == null) return null
  const username = String(actor.preferredUsername)
  return username ? `@${username}@${host}` : null
}

/** 匹配 bot_following 中 pending 的待处理关注行（按 handle 或 actorId） */
function pendingFollowMatch(botId: string, handle: string | null, actorId: string | null) {
  const match = or(
    ...(handle ? [eq(botFollowing.handle, handle)] : []),
    ...(actorId ? [eq(botFollowing.actorId, actorId)] : []),
  )
  if (!match) return null
  return and(eq(botFollowing.botId, botId), eq(botFollowing.status, "pending"), match)
}

/** Bot 关注联邦宇宙用户：发送 Follow 并记录 pending 状态 */
export async function followActor(botId: string, handle: string) {
  const bot = await getActiveBot(botId)

  const session = await bots.getSession(origin, bot.preferredUsername)
  await session.follow(handle) // 幂等，发送 Follow Activity

  await db.insert(botFollowing).values({
    id: `${botId}:${handle}`,
    botId,
    handle,
  }).onConflictDoNothing()
}

/** Bot 取消关注：发送 Undo Follow 并删除本地记录 */
export async function unfollowActor(botId: string, handle: string) {
  const bot = await getActiveBot(botId)

  const session = await bots.getSession(origin, bot.preferredUsername)
  await session.unfollow(handle)

  await db.delete(botFollowing)
    .where(and(eq(botFollowing.botId, botId), eq(botFollowing.handle, handle)))
}

// 对方接受了 bot 的关注 → 将 pending 更新为 accepted 并回填 actor 元数据
bots.onAcceptFollow = async (session, accepter) => {
  const bot = await findBotByUsername(session.bot.identifier)
  if (!bot) return
  const actorId = accepter.id?.href ?? null
  const handle = actorHandleOf(accepter)
  const values = {
    status: "accepted",
    actorId,
    actorName: actorDisplayName(accepter),
    actorAvatar: accepter.iconId?.href ?? null,
  }
  const where = pendingFollowMatch(bot.id, handle, actorId)
  if (!where) return

  const updated = await db.update(botFollowing)
    .set(values)
    .where(where)
    .returning({ id: botFollowing.id })
  // 找不到 pending 行（例如非本服务发起的关注）时兜底落一条 accepted 记录
  if (updated.length === 0 && handle && actorId) {
    await db.insert(botFollowing).values({
      id: `${bot.id}:${handle}`,
      botId: bot.id,
      handle,
      ...values,
    }).onConflictDoNothing()
  }
}

// 对方拒绝了 bot 的关注 → 将 pending 标记为 rejected
bots.onRejectFollow = async (session, rejecter) => {
  const bot = await findBotByUsername(session.bot.identifier)
  if (!bot) return
  const actorId = rejecter.id?.href ?? null
  const where = pendingFollowMatch(bot.id, actorHandleOf(rejecter), actorId)
  if (!where) return
  await db.update(botFollowing)
    .set({ status: "rejected" })
    .where(where)
}

// 收到时间线消息 → 持久化到 bot_inbox（只保留已关注用户的原创帖，按 activityId 去重）
bots.onMessage = async (session, message) => {
  // 过滤回复/提及等，只记录时间线上的原创帖
  if (message.replyTarget != null) return
  const bot = await findBotByUsername(session.bot.identifier)
  if (!bot) return
  const actorId = message.actor.id?.href
  if (!actorId) return

  // 仅保存 bot 已接受关注用户的动态，避免把提及/私信混入时间线
  const [following] = await db.select({ id: botFollowing.id })
    .from(botFollowing)
    .where(and(
      eq(botFollowing.botId, bot.id),
      eq(botFollowing.actorId, actorId),
      eq(botFollowing.status, "accepted"),
    ))
    .limit(1)
  if (!following) return

  await db.insert(botInbox).values({
    id: crypto.randomUUID(),
    botId: bot.id,
    activityId: message.id.href,
    actorId,
    actorName: actorDisplayName(message.actor),
    actorAvatar: message.actor.iconId?.href ?? null,
    content: message.text,
    url: message.id.href,
    publishedAt: message.published ? new Date(message.published.epochMilliseconds) : new Date(),
  }).onConflictDoNothing() // activityId 唯一索引兜底去重
}

// ── RSS 发布轮询 ──

const published = new Set<string>()
let baselined = false

type BotRow = typeof botsTable.$inferSelect
type BotSession = Awaited<ReturnType<typeof bots.getSession>>
type FeedDb = ReturnType<typeof createCouchDb>

async function pollFeeds() {
  // 首次运行先建立基线，之后轮询新条目
  if (!baselined) {
    await baselinePublishedEntries()
    return
  }
  await pollNewEntries()
}

/** 首次运行：将各 feed 已有条目加入发布基线，避免重复发布历史条目 */
async function baselinePublishedEntries() {
  await forEachBotFeed(async (bot, feedId) => {
    const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
    try {
      const result = await feedDb.view("main", "entries-by-date", { limit: 50 })
      for (const row of result.rows) {
        const val = row.value as { _id: string } | undefined
        if (val?._id) published.add(`${bot.id}:${val._id}`)
      }
    } catch {
      // feed 库可能还不存在，跳过
    }
  })
  baselined = true
  console.log(`BotKit baseline: ${published.size} entries tracked`)
}

/** 遍历所有启用 Bot 及其关联的 feed */
async function forEachBotFeed(fn: (bot: BotRow, feedId: string) => Promise<void>) {
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))
  for (const bot of activeBots) {
    const feedLinks = await db.select({ feedId: botFeeds.feedId })
      .from(botFeeds)
      .where(eq(botFeeds.botId, bot.id))
    for (const { feedId } of feedLinks) {
      await fn(bot, feedId)
    }
  }
}

/** 轮询所有 Bot 的 feed，抓取新条目并发布到 ActivityPub */
async function pollNewEntries() {
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))

  for (const bot of activeBots) {
    const feedLinks = await db.select({ feedId: botFeeds.feedId })
      .from(botFeeds)
      .where(eq(botFeeds.botId, bot.id))
    if (feedLinks.length === 0) continue

    // 每个 Bot 只建立一次会话，供其所有 feed 发布使用
    const session = await bots.getSession(origin, bot.preferredUsername)
    let botCount = 0
    for (const { feedId } of feedLinks) {
      botCount += await publishFeedEntries(bot, session, feedId)
    }

    if (botCount > 0) {
      console.log(`Bot ${bot.preferredUsername}: total ${botCount} new entry(s) published`)
    }
  }
}

/** 抓取单个 feed 的新条目并发布到 ActivityPub，返回发布数量 */
async function publishFeedEntries(bot: BotRow, session: BotSession, feedId: string): Promise<number> {
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  let count = 0

  try {
    const result = await feedDb.view("main", "entries-by-date", { limit: 10 })
    for (const row of result.rows) {
      const val = row.value as { _id: string } | undefined
      if (!val?._id) continue
      const key = `${bot.id}:${val._id}`
      if (published.has(key)) continue

      await publishEntry(bot, session, feedDb, val._id)
      published.add(key)
      count++
    }
  } catch {
    // feed 库不存在或无条目，跳过
  }

  if (count > 0) {
    console.log(`Bot ${bot.preferredUsername}: ${count} new entry(s) from ${feedId}`)
  }
  return count
}

/** 发布单条 entry 到 ActivityPub，并回写 outbox 的 activityId */
async function publishEntry(bot: BotRow, session: BotSession, feedDb: FeedDb, entryId: string) {
  const doc = await feedDb.get(entryId) as unknown as EntryDoc
  const content = doc.url ? `${doc.title}\n${doc.url}` : doc.title

  const activity = await session.publish(text`${content}`)
  const activityId = activity?.id?.toString?.() ?? activity?.id?.href ?? null
  if (activityId) {
    await db.update(botOutbox)
      .set({ activityId: String(activityId) })
      .where(eq(botOutbox.entryId, entryId))
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
