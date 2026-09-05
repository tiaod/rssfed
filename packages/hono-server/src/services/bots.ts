import crypto from "node:crypto"
import { eq, and } from "drizzle-orm"
import { db, bots, attachments, botFeeds, feeds } from "../db"
import { nanoServer } from "../couchdb/client"
import { getSubscribedFeedIds, listSubscriptionsForUser } from "./feeds"

/**
 * Bot / 分组管理服务层（用户级）。
 *
 * bots 表以 userId 归属，天然按用户隔离。这里封装 CRUD 与 feed 关联，
 * 供 MCP 工具（list/create/update/delete/add_feed/remove_feed/organize）复用。
 * 所有函数都以 userId 为边界；add_feed 只允许挂「用户自己订阅的源」。
 */

/** 列出当前用户的 Bot */
export async function listBotsForUser(userId: string) {
  return db.select().from(bots).where(eq(bots.userId, userId))
}

/** 创建 Bot（可选手填外链头像） */
export async function createBot(
  userId: string,
  input: {
    name: string
    description?: string
    preferredUsername: string
    avatarUrl?: string
    isActive?: boolean
  },
) {
  let avatarAttachmentId: string | null = null
  if (input.avatarUrl) {
    const [attachment] = await db.insert(attachments).values({
      id: crypto.randomUUID(),
      storageKey: null,
      url: input.avatarUrl,
    }).returning()
    avatarAttachmentId = attachment?.id ?? null
  }
  const [bot] = await db.insert(bots).values({
    id: crypto.randomUUID(),
    userId,
    name: input.name,
    description: input.description,
    preferredUsername: input.preferredUsername,
    avatarUrl: input.avatarUrl ?? null,
    avatarAttachmentId,
    isActive: input.isActive ?? true,
  }).returning()
  if (!bot) throw new Error("failed to create bot")
  return bot
}

/** 更新 Bot 元信息（仅属于当前用户） */
export async function updateBot(userId: string, botId: string, patch: Record<string, unknown>): Promise<boolean> {
  const updated = await db.update(bots)
    .set(patch)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .returning({ id: bots.id })
  return updated.length > 0
}

/** 删除 Bot（含 CouchDB 产出库）；仅属于当前用户时可删 */
export async function deleteBot(userId: string, botId: string): Promise<boolean> {
  const [bot] = await db.select().from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1)
  if (!bot) return false
  if (bot.couchDbName) {
    try { await nanoServer.db.destroy(bot.couchDbName) } catch { /* 库不存在，忽略 */ }
  }
  await db.delete(bots).where(and(eq(bots.id, botId), eq(bots.userId, userId)))
  return true
}

/** 给 Bot 关联一个 feed（仅当 feed 属当前用户订阅时；重复关联幂等） */
export async function addBotFeed(userId: string, botId: string, feedId: string): Promise<"ok" | "bot-not-owner" | "feed-not-subscribed"> {
  const [bot] = await db.select().from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1)
  if (!bot) return "bot-not-owner"
  const subscribed = await getSubscribedFeedIds(userId)
  if (!subscribed.has(feedId)) return "feed-not-subscribed"
  // 仅当 feed 在注册表中存在时关联
  const [feed] = await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
  if (!feed) return "feed-not-subscribed"
  await db.insert(botFeeds).values({ id: `${botId}:${feedId}`, botId, feedId }).onConflictDoNothing()
  return "ok"
}

/** 解除 Bot 与 feed 的关联（仅属于当前用户） */
export async function removeBotFeed(userId: string, botId: string, feedId: string): Promise<boolean> {
  const [bot] = await db.select().from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1)
  if (!bot) return false
  await db.delete(botFeeds).where(eq(botFeeds.id, `${botId}:${feedId}`))
  return true
}

/** 获取某 Bot 已关联的 feed 列表（带标题与 URL）；仅属于当前用户 */
export async function listBotFeeds(userId: string, botId: string) {
  const [bot] = await db.select().from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1)
  if (!bot) return null
  const rows = await db.select({
    feedId: botFeeds.feedId,
    title: feeds.title,
    url: feeds.url,
  })
    .from(botFeeds)
    .innerJoin(feeds, eq(feeds.id, botFeeds.feedId))
    .where(eq(botFeeds.botId, botId))
  return rows
}

/**
 * 组合工具：根据用户当前订阅的 feed 列表，把订阅自动分组成若干 Bot。
 * 这里做一个「按 category 分组」的简单启发式：同一 category 订阅归入一个 Bot，
 * 没有 category 的归入「未分组」。返回创建/更新结果概览。
 */
export async function organizeBots(userId: string) {
  const subscribed = await getSubscribedFeedIds(userId)
  if (!subscribed.size) return { created: 0, groups: [] }

  // 读取用户订阅文档以获取 category 信息
  const subs = await listSubscriptionsForUser(userId)
  const feedSubs = subs.filter((s) => s.kind === "feed")

  const byCategory = new Map<string, { feedId: string, title: string }[]>()
  for (const s of feedSubs) {
    const cat = s.category ?? "未分组"
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push({ feedId: s.feedId, title: s.title })
  }

  const groups: { category: string, feedCount: number, botId?: string, name?: string }[] = []
  for (const [category, items] of byCategory) {
    const existing = await db.select().from(bots)
      .where(and(eq(bots.userId, userId), eq(bots.name, category))).limit(1)
    let botId: string
    if (existing[0]) {
      botId = existing[0].id
      // 把该组所有 feed 关联进去
      for (const item of items) {
        await db.insert(botFeeds).values({ id: `${botId}:${item.feedId}`, botId, feedId: item.feedId }).onConflictDoNothing()
      }
    } else {
      const bot = await createBot(userId, {
        name: category,
        preferredUsername: category.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "bot",
      })
      botId = bot.id
      for (const item of items) {
        await db.insert(botFeeds).values({ id: `${botId}:${item.feedId}`, botId, feedId: item.feedId }).onConflictDoNothing()
      }
    }
    groups.push({ category, feedCount: items.length, botId, name: category })
  }

  return { created: groups.filter((g) => g.botId).length, groups }
}
