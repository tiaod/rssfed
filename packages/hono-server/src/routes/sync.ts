import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { ensureUserDatabase, authenticatedUrl } from "../couchdb/client"
import { db, userFeedSyncTable, COUCHDB_GLOBAL } from "../db"
import { auth } from "../auth"

export const syncRouter = new Hono()

syncRouter.post("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const userId = session.user.id
  const { feedIds } = await c.req.json()
  if (!feedIds?.length) return c.json({ error: "feedIds required" }, 400)

  await ensureUserDatabase(userId)

  const response = await fetch(`${authenticatedUrl}/_replicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: `${authenticatedUrl}/${COUCHDB_GLOBAL}`,
      target: `${authenticatedUrl}/rssfed-user:${userId}`,
      filter: "main/entries-by-feeds",
      query_params: { feed_ids: JSON.stringify(feedIds) },
      create_target: false,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return c.json({ error: `Replication failed: ${err}` }, 502)
  }

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
