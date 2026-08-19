import { Hono, type Context, type Next } from "hono"
import crypto from "node:crypto"
import { db, bots, feeds, attachments, botFeeds, botFollowing, botInbox, type Bot } from "../db"
import { eq, and, desc } from "drizzle-orm"
import { auth } from "../auth"
import { followActor, unfollowActor } from "../bots"
import { ApiError, cleanupAttachment, handleAvatarUpload } from "../avatar"
import { createCouchDb, ensureBotDatabase, nanoServer } from "../couchdb/client"

type BotVariables = { bot: Bot; userId: string }

export const botsRouter = new Hono<{ Variables: BotVariables }>()

/** 校验登录态 + Bot 所有权，并将 Bot 写入 context（未登录 401，无权限/不存在 404） */
async function requireOwnedBot(c: Context<{ Variables: BotVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const id = c.req.param("id")!
  const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, session.user.id))).limit(1)
  if (!bot) return c.json({ error: "not found" }, 404)

  c.set("userId", session.user.id)
  c.set("bot", bot)
  await next()
}

/** 校验登录态并将 userId 写入 context（未登录 401） */
async function requireAuth(c: Context<{ Variables: BotVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
}

botsRouter.post("/", requireAuth, async (c) => {
  const body = await c.req.json()

  // 手填外链头像：同步建一条 storageKey=null 的附件行（无文件可删），业务表只留冗余 URL + 外键
  let avatarAttachmentId: string | null = null
  if (body.avatarUrl) {
    const [attachment] = await db.insert(attachments).values({
      id: crypto.randomUUID(),
      storageKey: null,
      url: body.avatarUrl,
    }).returning()
    avatarAttachmentId = attachment?.id ?? null
  }

  const bot = await db.insert(bots).values({
    id: crypto.randomUUID(),
    userId: c.get("userId"),
    name: body.name,
    description: body.description,
    preferredUsername: body.preferredUsername,
    avatarUrl: body.avatarUrl ?? null,
    avatarAttachmentId,
    isActive: body.isActive ?? true,
  }).returning()
  return c.json(bot[0], 201)
})

botsRouter.get("/", requireAuth, async (c) => {
  const userBots = await db.select().from(bots).where(eq(bots.userId, c.get("userId")))
  return c.json(userBots)
})

/** 公开 Bot 列表（广场页）：所有启用状态的 bot 元数据，供用户发现并订阅产出 */
botsRouter.get("/public", async (c) => {
  const publicBots = await db.select().from(bots).where(eq(bots.isActive, true))
  return c.json(publicBots)
})

botsRouter.put("/:id", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const body = await c.req.json()
  await db.update(bots).set(body).where(eq(bots.id, id))
  return c.json({ success: true })
})

botsRouter.delete("/:id", requireOwnedBot, async (c) => {
  const bot = c.get("bot")
  // 删除 CouchDB 产出库（库可能尚未创建，静默跳过）
  if (bot.couchDbName) {
    try { await nanoServer.db.destroy(bot.couchDbName) } catch { /* 库不存在，忽略 */ }
  }
  await db.delete(bots).where(eq(bots.id, bot.id))
  // 清理头像附件（S3 文件 + 元数据行），避免孤儿
  await cleanupAttachment(bot.avatarAttachmentId)
  return c.json({ success: true })
})

/** 上传 Bot 头像（multipart: file 字段），S3 存储 + attachments 表外键 */
botsRouter.post("/:id/avatar", requireOwnedBot, async (c) => {
  const bot = c.get("bot")
  try {
    const attachment = await handleAvatarUpload(c, bot.id, async (newAttachmentId, url) => {
      // 先读旧外键再更新：RETURNING 返回的是更新后值，不能用来定位旧附件
      const [before] = await db.select({ oldAttachmentId: bots.avatarAttachmentId })
        .from(bots).where(eq(bots.id, bot.id)).limit(1)
      await db.update(bots)
        .set({ avatarUrl: url, avatarAttachmentId: newAttachmentId })
        .where(eq(bots.id, bot.id))
      return { oldAttachmentId: before?.oldAttachmentId ?? null }
    })
    return c.json({ success: true, avatarUrl: attachment.url })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

botsRouter.post("/:id/feeds", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const { feedId } = await c.req.json()

  await db.insert(botFeeds).values({
    id: `${id}:${feedId}`,
    botId: id,
    feedId,
  }).onConflictDoNothing() // 重复关联时幂等跳过
  return c.json({ success: true }, 201)
})

/** 获取 Bot 已关联的订阅源列表（join feeds 表带出标题与 URL） */
botsRouter.get("/:id/feeds", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!

  const rows = await db.select({
    feedId: botFeeds.feedId,
    title: feeds.title,
    url: feeds.url,
  })
    .from(botFeeds)
    .innerJoin(feeds, eq(feeds.id, botFeeds.feedId))
    .where(eq(botFeeds.botId, id))

  return c.json(rows)
})

botsRouter.delete("/:id/feeds/:feedId", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const feedId = c.req.param("feedId")!
  await db.delete(botFeeds).where(eq(botFeeds.id, `${id}:${feedId}`))
  return c.json({ success: true })
})

/** 获取 Bot 的产出（per-bot CouchDB 产出库，即 ActivityPub outbox 的内容源） */
botsRouter.get("/:id/outbox", async (c) => {
  const { id } = c.req.param()
  const limit = parseInt(c.req.query("limit") ?? "50")
  const offset = parseInt(c.req.query("offset") ?? "0")

  // entries-by-date 视图按 publishedAt 排序：descending 倒序 + skip/limit 分页
  const botDb = createCouchDb(await ensureBotDatabase(id))
  const result = await botDb.view("main", "entries-by-date", { descending: true, limit, skip: offset })
  const items = await Promise.all(
    result.rows.map((row) => botDb.get((row.value as { _id: string })._id)),
  )

  return c.json(items)
})

/** Bot 关注联邦宇宙用户（输入句柄，如 @alice@example.com） */
botsRouter.post("/:id/follow", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const body = await c.req.json()
  const handle = typeof body?.handle === "string" ? body.handle.trim() : ""
  if (!handle) return c.json({ error: "handle required" }, 400)

  try {
    await followActor(id, handle)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "follow failed" }, 400)
  }
  return c.json({ success: true }, 201)
})

/** Bot 取消关注联邦宇宙用户 */
botsRouter.post("/:id/unfollow", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const body = await c.req.json()
  const handle = typeof body?.handle === "string" ? body.handle.trim() : ""
  if (!handle) return c.json({ error: "handle required" }, 400)

  await unfollowActor(id, handle)
  return c.json({ success: true })
})

/** Bot 的关注列表（含 pending/accepted/rejected 状态） */
botsRouter.get("/:id/following", async (c) => {
  const { id } = c.req.param()

  const items = await db.select()
    .from(botFollowing)
    .where(eq(botFollowing.botId, id))
    .orderBy(desc(botFollowing.createdAt))

  return c.json(items)
})

/** Bot 视角的时间线 — 所关注用户发布的动态 */
botsRouter.get("/:id/timeline", async (c) => {
  const { id } = c.req.param()
  const limit = parseInt(c.req.query("limit") ?? "50")
  const offset = parseInt(c.req.query("offset") ?? "0")

  const items = await db.select()
    .from(botInbox)
    .where(eq(botInbox.botId, id))
    .orderBy(desc(botInbox.publishedAt))
    .limit(limit)
    .offset(offset)

  return c.json(items)
})
