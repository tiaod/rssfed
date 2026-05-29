import { Hono } from "hono"
import { db, botsTable, botFeedsTable, botFollowersTable } from "../db"
import { eq } from "drizzle-orm"

export const botsRouter = new Hono()

botsRouter.post("/", async (c) => {
  const body = await c.req.json()
  const bot = await db.insert(botsTable).values({
    id: `bot:${body.userId}:${body.name}`,
    ...body,
  }).returning()
  return c.json(bot[0], 201)
})

botsRouter.get("/", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const bots = await db.select().from(botsTable).where(eq(botsTable.userId, userId))
  return c.json(bots)
})

botsRouter.put("/:id", async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  await db.update(botsTable).set(body).where(eq(botsTable.id, id))
  return c.json({ success: true })
})

botsRouter.delete("/:id", async (c) => {
  const { id } = c.req.param()
  await db.delete(botsTable).where(eq(botsTable.id, id))
  return c.json({ success: true })
})

botsRouter.post("/:id/feeds", async (c) => {
  const { id } = c.req.param()
  const { feedId } = await c.req.json()
  await db.insert(botFeedsTable).values({
    id: `${id}:${feedId}`,
    botId: id,
    feedId,
  })
  return c.json({ success: true }, 201)
})

botsRouter.delete("/:id/feeds/:feedId", async (c) => {
  const { id, feedId } = c.req.param()
  await db.delete(botFeedsTable).where(eq(botFeedsTable.id, `${id}:${feedId}`))
  return c.json({ success: true })
})