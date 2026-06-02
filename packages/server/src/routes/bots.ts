import { Hono } from "hono"
import crypto from "node:crypto"
import { db, botsTable, botFeedsTable, botFollowersTable } from "../db"
import { eq, and } from "drizzle-orm"
import { auth } from "../auth"

export const botsRouter = new Hono()

botsRouter.post("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const body = await c.req.json()
  const bot = await db.insert(botsTable).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    name: body.name,
    description: body.description,
    preferredUsername: body.preferredUsername,
    avatarUrl: body.avatarUrl,
    isActive: body.isActive ?? true,
  }).returning()
  return c.json(bot[0], 201)
})

botsRouter.get("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const bots = await db.select().from(botsTable).where(eq(botsTable.userId, session.user.id))
  return c.json(bots)
})

botsRouter.put("/:id", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { id } = c.req.param()
  const body = await c.req.json()

  const [bot] = await db.select().from(botsTable).where(and(eq(botsTable.id, id), eq(botsTable.userId, session.user.id))).limit(1)
  if (!bot) return c.json({ error: "not found" }, 404)

  await db.update(botsTable).set(body).where(eq(botsTable.id, id))
  return c.json({ success: true })
})

botsRouter.delete("/:id", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { id } = c.req.param()

  const [bot] = await db.select().from(botsTable).where(and(eq(botsTable.id, id), eq(botsTable.userId, session.user.id))).limit(1)
  if (!bot) return c.json({ error: "not found" }, 404)

  await db.delete(botsTable).where(eq(botsTable.id, id))
  return c.json({ success: true })
})

botsRouter.post("/:id/feeds", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { id } = c.req.param()
  const { feedId } = await c.req.json()

  const [bot] = await db.select().from(botsTable).where(and(eq(botsTable.id, id), eq(botsTable.userId, session.user.id))).limit(1)
  if (!bot) return c.json({ error: "not found" }, 404)

  await db.insert(botFeedsTable).values({
    id: `${id}:${feedId}`,
    botId: id,
    feedId,
  })
  return c.json({ success: true }, 201)
})

botsRouter.delete("/:id/feeds/:feedId", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { id, feedId } = c.req.param()

  const [bot] = await db.select().from(botsTable).where(and(eq(botsTable.id, id), eq(botsTable.userId, session.user.id))).limit(1)
  if (!bot) return c.json({ error: "not found" }, 404)

  await db.delete(botFeedsTable).where(eq(botFeedsTable.id, `${id}:${feedId}`))
  return c.json({ success: true })
})
