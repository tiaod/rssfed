import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { ensureUserDatabase, getUserPouch, getGlobalPouch } from "../couchdb/client"
import { db, userFeedSyncTable, SYNC_BATCH_SIZE } from "../db"
import { auth } from "../auth"

export const syncRouter = new Hono()

syncRouter.post("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const userId = session.user.id
  const { feedIds } = await c.req.json()
  if (!feedIds?.length) return c.json({ error: "feedIds required" }, 400)

  await ensureUserDatabase(userId)
  const globalPouch = getGlobalPouch()
  const userPouch = getUserPouch(userId)

  await userPouch.replicate.from(globalPouch, {
    filter: (doc: any) => {
      if (doc.type !== "entry") return false
      return feedIds.includes(doc.feedId)
    },
    batch_size: SYNC_BATCH_SIZE,
  })

  for (const feedId of feedIds) {
    await db.insert(userFeedSyncTable).values({
      id: `${userId}:${feedId}`,
      userId,
      feedId,
      lastSyncAt: new Date(),
    }).onConflictDoUpdate({
      target: userFeedSyncTable.id,
      set: { lastSyncAt: new Date() },
    })
  }

  return c.json({ status: "completed" })
})

syncRouter.get("/status", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  const syncs = await db.select().from(userFeedSyncTable).where(eq(userFeedSyncTable.userId, session.user.id))
  return c.json(syncs)
})