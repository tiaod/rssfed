import { Hono, type Context, type Next } from "hono"
import crypto from "node:crypto"
import { db, bots, botFeeds, botOutbox, botFollowing, botInbox, type Bot } from "../db"
import { eq, and, desc } from "drizzle-orm"
import { auth } from "../auth"
import { followActor, unfollowActor } from "../bots"

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
  const bot = await db.insert(bots).values({
    id: crypto.randomUUID(),
    userId: c.get("userId"),
    name: body.name,
    description: body.description,
    preferredUsername: body.preferredUsername,
    avatarUrl: body.avatarUrl,
    isActive: body.isActive ?? true,
  }).returning()
  return c.json(bot[0], 201)
})

botsRouter.get("/", requireAuth, async (c) => {
  const userBots = await db.select().from(bots).where(eq(bots.userId, c.get("userId")))
  return c.json(userBots)
})

botsRouter.put("/:id", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const body = await c.req.json()
  await db.update(bots).set(body).where(eq(bots.id, id))
  return c.json({ success: true })
})

botsRouter.delete("/:id", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  await db.delete(bots).where(eq(bots.id, id))
  return c.json({ success: true })
})

botsRouter.post("/:id/feeds", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const { feedId } = await c.req.json()

  await db.insert(botFeeds).values({
    id: `${id}:${feedId}`,
    botId: id,
    feedId,
  })
  return c.json({ success: true }, 201)
})

botsRouter.delete("/:id/feeds/:feedId", requireOwnedBot, async (c) => {
  const id = c.req.param("id")!
  const feedId = c.req.param("feedId")!
  await db.delete(botFeeds).where(eq(botFeeds.id, `${id}:${feedId}`))
  return c.json({ success: true })
})

/** 获取 Bot 的出站队列（ActivityPub outbox 内容） */
botsRouter.get("/:id/outbox", async (c) => {
  const { id } = c.req.param()
  const limit = parseInt(c.req.query("limit") ?? "50")
  const offset = parseInt(c.req.query("offset") ?? "0")

  const items = await db.select()
    .from(botOutbox)
    .where(eq(botOutbox.botId, id))
    .orderBy(desc(botOutbox.publishedAt))
    .limit(limit)
    .offset(offset)

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
