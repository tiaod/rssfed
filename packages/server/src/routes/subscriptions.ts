import { Hono } from "hono"
import { db, userSubscriptionsTable, userFeedSyncTable } from "../db"
import { eq } from "drizzle-orm"

export const subscriptionsRouter = new Hono()

subscriptionsRouter.post("/", async (c) => {
  const { userId, feedId, category } = await c.req.json()
  await db.insert(userSubscriptionsTable).values({
    id: `${userId}:${feedId}`,
    userId,
    feedId,
    category,
  })
  return c.json({ success: true }, 201)
})

subscriptionsRouter.delete("/", async (c) => {
  const { userId, feedId } = await c.req.json()
  await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.id, `${userId}:${feedId}`))
  return c.json({ success: true })
})

subscriptionsRouter.get("/", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId required" }, 400)
  const subs = await db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId))
  return c.json(subs)
})