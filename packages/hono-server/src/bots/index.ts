import { createInstance, text } from "@fedify/botkit"
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres"
import postgres from "postgres"
import crypto from "node:crypto"
import { db, bots as botsTable, botFollowing, botInbox, type EntryDoc } from "../db"
import { and, eq, or } from "drizzle-orm"
import { createCouchDb, ensureBotDatabase } from "../couchdb/client"

const origin = process.env.BOTS_BASE_URL ?? "http://localhost:3001"
const pollIntervalMs = parseInt(process.env.CHECK_INTERVAL ?? "300000")

/**
 * Fedify 的表（`fedify_kv_v2` / `fedify_message_v2`）统一建在这个独立 schema 下。
 *
 * 它们由 `@fedify/postgres` 自建自管、不在本仓库的 Drizzle schema 里。若留在 `public`，
 * `drizzle-kit push` 会把它们当成「多余的副本」直接 DROP —— 而 migrate 服务跑的正是
 * `push --force`（无人值守、自动批准数据丢失语句），等于每次部署都可能清掉 Bot 的
 * ActivityPub 私钥。放进独立 schema 后，drizzle 默认只管理 `public`，结构上就够不着。
 */
export const FEDIFY_SCHEMA = "fedify"

// BotKit KV 存储与消息队列：PostgreSQL（@fedify/postgres 官方实现，表由包自动管理）。
// 使用独立 postgres.js 连接，与 drizzle 业务连接分离，避免 KV 高频读写干扰业务查询。
// `options` 是 PG 的启动参数，用它把本连接的 search_path 指向 Fedify 专用 schema（见上）。
const botkitSql = postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/rssfed", {
  connection: { options: `-c search_path=${FEDIFY_SCHEMA}` },
})

/**
 * 确保 Fedify 专用 schema 存在（幂等）。
 *
 * Fedify 只会建表、不会建 schema，所以必须在它首次建表前调用 —— 由应用启动流程
 * （src/index.ts）负责。刻意不写成模块顶层 await：那样任何 import 本模块的代码
 * （包括单元测试）都会在加载阶段就要求数据库可用。
 */
export async function ensureFedifySchema() {
  await botkitSql`CREATE SCHEMA IF NOT EXISTS ${botkitSql(FEDIFY_SCHEMA)}`
}

// BotKit 的 KV 存储：Bot actor 的密钥对等联邦身份数据存在这里，删除 Bot 时必须一并清理
// （见 clearBotKv）。单独持有引用是为了能主动操作它。
const kv = new PostgresKvStore(botkitSql)

// 创建 BotKit Instance
const instance = createInstance<void>({
  kv,
  queue: new PostgresMessageQueue(botkitSql),
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

/** BotKit 在 KV 中存放 Bot 数据的键前缀（其内部约定，键形如 `["_botkit","bots",username,"keyPairs"]`） */
const BOT_KV_PREFIX = ["_botkit", "bots"] as const

/**
 * 清理某个 Bot 在 Fedify KV 中留下的全部数据（主要是 actor 密钥对）。
 *
 * 必须在删除 Bot 时一并调用：密钥对不在 bots 表里，只删表行的话，之后用同名
 * username 重建的 Bot 会从 KV 读到旧密钥对并复用它 —— 而 preferred_username
 * 现在有唯一约束，同名即同一联邦身份，复用私钥等于身份串号。
 */
export async function clearBotKv(username: string) {
  const prefix = [...BOT_KV_PREFIX, username] as const
  let removed = 0
  for await (const entry of kv.list(prefix)) {
    await kv.delete(entry.key)
    removed++
  }
  if (removed > 0) {
    console.log(`[Bot] 已清理 ${username} 的 ${removed} 条 Fedify KV 记录（含密钥对）`)
  }
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

// ── RSS 产出发布轮询（内容源：per-bot CouchDB 产出库）──

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

/** 首次运行：将各 bot 产出库已有条目加入发布基线，避免重复发布历史条目 */
async function baselinePublishedEntries() {
  await forEachBot(async (bot) => {
    const botDb = createCouchDb(await ensureBotDatabase(bot.id))
    try {
      const result = await botDb.view("main", "entries-by-date", { limit: 50 })
      for (const row of result.rows) {
        const val = row.value as { _id: string } | undefined
        if (val?._id) published.add(`${bot.id}:${val._id}`)
      }
    } catch {
      // bot 库可能还不存在，跳过
    }
  })
  baselined = true
  console.log(`BotKit baseline: ${published.size} entries tracked`)
}

/** 遍历所有启用 Bot */
async function forEachBot(fn: (bot: BotRow) => Promise<void>) {
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))
  for (const bot of activeBots) {
    await fn(bot)
  }
}

/** 轮询所有 Bot 的产出库，发布新条目到 ActivityPub */
async function pollNewEntries() {
  const activeBots = await db.select().from(botsTable)
    .where(eq(botsTable.isActive, true))

  for (const bot of activeBots) {
    // 每个 Bot 只建立一次会话，供其产出发布使用
    const session = await bots.getSession(origin, bot.preferredUsername)
    const count = await publishBotEntries(bot, session)
    if (count > 0) {
      console.log(`Bot ${bot.preferredUsername}: total ${count} new entry(s) published`)
    }
  }
}

/** 抓取单个 bot 产出库的新条目并发布到 ActivityPub，返回发布数量 */
async function publishBotEntries(bot: BotRow, session: BotSession): Promise<number> {
  const botDb = createCouchDb(await ensureBotDatabase(bot.id))
  let count = 0

  try {
    const result = await botDb.view("main", "entries-by-date", { limit: 10 })
    for (const row of result.rows) {
      const val = row.value as { _id: string } | undefined
      if (!val?._id) continue
      const key = `${bot.id}:${val._id}`
      if (published.has(key)) continue

      await publishEntry(bot, session, botDb, val._id)
      published.add(key)
      count++
    }
  } catch {
    // bot 库不存在或无条目，跳过
  }

  if (count > 0) {
    console.log(`Bot ${bot.preferredUsername}: ${count} new entry(s) published`)
  }
  return count
}

/** 发布单条产出到 ActivityPub，并把 activityId 持久化回写产出 doc（重启后也不会重复发布） */
async function publishEntry(bot: BotRow, session: BotSession, botDb: FeedDb, entryId: string) {
  const doc = await botDb.get(entryId) as unknown as EntryDoc & { activityId?: string }
  // doc 已回写过 activityId → 已发布，跳过
  if (doc.activityId) return
  const content = doc.url ? `${doc.title}\n${doc.url}` : doc.title

  const activity = await session.publish(text`${content}`)
  const activityId = activity?.id?.toString?.() ?? activity?.id?.href ?? null
  if (activityId) {
    // get 返回的 doc 自带 _rev，insert 即更新
    await botDb.insert({ ...doc, activityId: String(activityId) } as any)
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
  return botkitSql.end()
}

export { instance }
