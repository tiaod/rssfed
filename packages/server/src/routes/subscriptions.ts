import { Hono } from "hono"
import { db, userSubscriptionsTable } from "../db"
import { eq } from "drizzle-orm"
import { auth } from "../auth"

export const subscriptionsRouter = new Hono()

subscriptionsRouter.post("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { feedId, category } = await c.req.json()
  const userId = session.user.id

  await db.insert(userSubscriptionsTable).values({
    id: `${userId}:${feedId}`,
    userId,
    feedId,
    category,
  })
  return c.json({ success: true }, 201)
})

subscriptionsRouter.delete("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { feedId } = await c.req.json()
  const userId = session.user.id

  await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.id, `${userId}:${feedId}`))
  return c.json({ success: true })
})

subscriptionsRouter.get("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const subs = await db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, session.user.id))
  return c.json(subs)
})
