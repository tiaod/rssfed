import { createFederation, generateCryptoKeyPair, exportJwk, importJwk } from '@fedify/fedify'
import { RedisKvStore, RedisMessageQueue } from '@fedify/redis'
import { Redis } from 'ioredis'
import {
  Person, Endpoints, Follow, Undo, Create, Like, Accept
} from '@fedify/vocab'
import type { Recipient } from '@fedify/vocab'
import { db } from '~server/lib/db'
import {
  federationActor, federationActorKey,
  federationFollow, federationFollower
} from '~/lib/schema/federation'
import { eq, and, desc } from 'drizzle-orm'
import { handleFollow, handleUndo, handleCreate, handleLike, handleAccept } from './federation-handlers'

export type FederationContextData = {
  userId: string | null
}

const origin = process.env.FEDERATION_ORIGIN || `http://localhost:${process.env.PORT || 3000}`
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

export const federation = createFederation<FederationContextData>({
  kv: new RedisKvStore(redis),
  queue: new RedisMessageQueue(() => redis),
  origin
})

federation
  .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
    const row = await db.query.federationActor.findFirst({
      where: eq(federationActor.preferredUsername, identifier)
    })
    if (!row) return null
    const keys = await ctx.getActorKeyPairs(identifier)
    return new Person({
      id: ctx.getActorUri(identifier),
      preferredUsername: identifier,
      name: row.name || undefined,
      summary: row.summary || undefined,
      url: ctx.getActorUri(identifier),
      inbox: ctx.getInboxUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      followers: ctx.getFollowersUri(identifier),
      following: ctx.getFollowingUri(identifier),
      endpoints: new Endpoints({
        sharedInbox: ctx.getInboxUri()
      }),
      publicKey: keys[0]?.cryptographicKey,
      assertionMethods: keys.map(k => k.multikey)
    })
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
    const row = await db.query.federationActor.findFirst({
      where: eq(federationActor.preferredUsername, identifier)
    })
    if (!row) return []

    const keyRows = await db.query.federationActorKey.findMany({
      where: eq(federationActorKey.actorId, row.id)
    })
    const stored = Object.fromEntries(keyRows.map(r => [r.keyType, r]))

    const keyTypes = ['RSASSA-PKCS1-v1_5', 'Ed25519'] as const
    const pairs: CryptoKeyPair[] = []

    for (const keyType of keyTypes) {
      const existing = stored[keyType]
      if (existing) {
        pairs.push({
          privateKey: await importJwk(JSON.parse(existing.privateKey), 'private'),
          publicKey: await importJwk(JSON.parse(existing.publicKey), 'public')
        })
      } else {
        const pair = await generateCryptoKeyPair(keyType)
        await db.insert(federationActorKey).values({
          id: crypto.randomUUID(),
          actorId: row.id,
          keyType,
          privateKey: JSON.stringify(await exportJwk(pair.privateKey)),
          publicKey: JSON.stringify(await exportJwk(pair.publicKey))
        })
        pairs.push(pair)
      }
    }
    return pairs
  })

federation
  .setInboxListeners('/users/{identifier}/inbox', '/inbox')
  .on(Follow, handleFollow)
  .on(Undo, handleUndo)
  .on(Create, handleCreate)
  .on(Like, handleLike)
  .on(Accept, handleAccept)

federation.setOutboxDispatcher('/users/{identifier}/outbox', async () => {
  return { items: [] }
})

federation.setFollowersDispatcher('/users/{identifier}/followers', async (_ctx, identifier) => {
  const rows = await db
    .select()
    .from(federationFollower)
    .innerJoin(federationActor, eq(federationActor.id, federationFollower.actorId))
    .where(eq(federationActor.preferredUsername, identifier))
    .orderBy(desc(federationFollower.createdAt))

  const items: Recipient[] = rows
    .filter(row => row.federation_follower.followerInboxUrl)
    .map(row => ({
      id: new URL(row.federation_follower.followerActorUri),
      inboxId: new URL(row.federation_follower.followerInboxUrl!),
      endpoints: row.federation_follower.followerSharedInboxUrl
        ? { sharedInbox: new URL(row.federation_follower.followerSharedInboxUrl) }
        : undefined
    }))

  return { items }
})

federation.setFollowingDispatcher('/users/{identifier}/following', async (_ctx, identifier) => {
  const rows = await db
    .select()
    .from(federationFollow)
    .innerJoin(federationActor, eq(federationActor.id, federationFollow.actorId))
    .where(
      and(
        eq(federationActor.preferredUsername, identifier),
        eq(federationFollow.status, 'accepted')
      )
    )
    .orderBy(desc(federationFollow.createdAt))

  const items = rows.map(row => new URL(row.federation_follow.targetActorUri))
  return { items }
})

federation.setNodeInfoDispatcher('/nodeinfo/2.1', async () => ({
  software: { name: 'RSSFed', version: '0.1.0' },
  protocols: ['activitypub'],
  usage: {
    users: { total: 0, activeHalfyear: 0, activeMonth: 0, activeDay: 0 },
    localPosts: 0,
    localComments: 0
  }
}))
