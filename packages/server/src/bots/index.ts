import { createFederation } from "@fedify/fedify"
import { RedisKvStore } from "@fedify/redis"
import { federation } from "@fedify/hono"
import { Service, Accept, Follow, Undo } from "@fedify/vocab"
import { db, botsTable, botFeedsTable, botFollowersTable, COUCHDB_GLOBAL, type EntryDoc } from "../db"
import { eq } from "drizzle-orm"
import { createCouchDb } from "../couchdb/client"
import IORedis from "ioredis"

const baseUrl = process.env.BOTS_BASE_URL ?? "http://localhost:3001"
const globalDb = createCouchDb(COUCHDB_GLOBAL)

const redis = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
})

export function shutdownBots() {
  return redis.quit()
}

const fedi = createFederation<void>({
  kv: new RedisKvStore(redis),
})

fedi.setActorDispatcher("/actor/{identifier}", async (ctx, identifier) => {
  const [bot] = await db.select().from(botsTable)
    .where(eq(botsTable.preferredUsername, identifier))
    .limit(1)
  if (!bot) return null

  const keyPairs = await ctx.getActorKeyPairs(bot.id)
  const publicKey = keyPairs[0]

  return new Service({
    id: new URL(`/actor/${bot.id}`, baseUrl),
    preferredUsername: bot.preferredUsername,
    name: bot.name,
    summary: bot.description,
    inbox: ctx.getInboxUri(bot.id),
    outbox: ctx.getOutboxUri(bot.id),
    followers: ctx.getFollowersUri(bot.id),
    publicKey: publicKey as any,
    url: new URL(`/actor/${bot.id}`, baseUrl),
  })
})

fedi.setInboxListeners("/actor/{identifier}/inbox")
  .on(Follow, async (ctx: any, follow: any) => {
    const follower = follow.actorId as URL
    const targetId = follow.objectId as URL | null
    if (!targetId || !follower) return

    const botId = targetId.href.split("/").pop()!
    const actor = await ctx.findActor(follower) as any
    if (!actor?.inboxId) return

    await db.insert(botFollowersTable).values({
      id: `${botId}:${follower.href}`,
      botId,
      actorId: follower.href,
      inboxUrl: actor.inboxId.href,
      sharedInboxUrl: actor.endpoints?.sharedInbox?.href,
      followCreatedAt: new Date(),
    })

    await ctx.sendActivity(
      { identifier: botId },
      follower.href,
      new Accept({ actor: targetId, object: follow }),
    )
  })
  .on(Undo, async (ctx: any, undo: any) => {
    const object = undo.object
    if (object?.type !== "Follow") return

    const follower = object.actorId as URL | undefined
    const targetId = object.objectId as URL | undefined
    if (!targetId || !follower) return

    const botId = targetId.href.split("/").pop()!
    const followerId = follower.href

    await db.delete(botFollowersTable).where(
      eq(botFollowersTable.id, `${botId}:${followerId}`),
    )
  })

export const fediMiddleware = federation(fedi, () => null) as any

async function checkAndPublish() {
  const activeBots = await db.select().from(botsTable).where(eq(botsTable.isActive, true))

  for (const bot of activeBots) {
    const feedIds = await db.select({ feedId: botFeedsTable.feedId })
      .from(botFeedsTable).where(eq(botFeedsTable.botId, bot.id))

    if (feedIds.length === 0) continue

    const followers = await db.select()
      .from(botFollowersTable).where(eq(botFollowersTable.botId, bot.id))

    if (followers.length === 0) continue

    for (const { feedId } of feedIds) {
      const result = await globalDb.view("main", "entries-by-feed", { key: feedId, limit: 5 })
      for (const row of result.rows) {
        const entry = row as unknown as { value: { _id: string } }
        if (!entry?.value?._id) continue

        const doc = await globalDb.get(entry.value._id) as unknown as EntryDoc
        const note = {
          type: "Note" as const,
          id: `${baseUrl}/note/${doc._id}`,
          attributedTo: `${baseUrl}/actor/${bot.id}`,
          content: `${doc.title}\n\n${doc.url}`,
          name: doc.title,
          published: doc.publishedAt,
        }

        await (fedi as any).sendActivity(
          { identifier: bot.id },
          followers.map(f => f.actorId),
          { type: "Create", actor: `${baseUrl}/actor/${bot.id}`, object: note },
        )
      }
    }
  }
}

setInterval(checkAndPublish, parseInt(process.env.CHECK_INTERVAL ?? "300000"))
console.log("Bot publisher started (check every 5 min)")