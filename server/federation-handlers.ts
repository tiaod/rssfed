import type { InboxContext } from '@fedify/fedify'
import type {
  Follow, Undo, Create, Like, Accept
} from '@fedify/vocab'
import {
  Note, getActorHandle,
  Accept as AcceptVocab, Follow as FollowVocab, Like as LikeVocab
} from '@fedify/vocab'
import type { FederationContextData } from './federation'
import { db } from '~server/lib/db'
import {
  federationActor,
  federationFollow, federationFollower, federationTimelineEntry
} from '~/lib/schema/federation'
import { eq, and } from 'drizzle-orm'

type Ctx = InboxContext<FederationContextData>

export async function handleFollow(ctx: Ctx, follow: Follow): Promise<void> {
  if (follow.objectId == null) return
  const target = ctx.parseUri(follow.objectId)
  if (target?.type !== 'actor') return

  const localActor = await db.query.federationActor.findFirst({
    where: eq(federationActor.preferredUsername, target.identifier)
  })
  if (!localActor) return

  const follower = await follow.getActor()
  if (follower?.id == null || follower.inboxId == null) return

  await db.insert(federationFollower).values({
    id: crypto.randomUUID(),
    actorId: localActor.id,
    followerActorUri: follower.id.href,
    followerHandle: await getActorHandle(follower) ?? null,
    followerName: follower.name?.toString() ?? null,
    followerInboxUrl: follower.inboxId.href,
    followerSharedInboxUrl: follower.endpoints?.sharedInbox?.href ?? null,
    followerUrl: follower.url ? String(follower.url) : null
  }).onConflictDoNothing()

  await ctx.sendActivity(
    { identifier: target.identifier },
    follower,
    new AcceptVocab({
      id: new URL(`#accepts/${crypto.randomUUID()}`, ctx.getActorUri(target.identifier)),
      actor: follow.objectId,
      to: follow.actorId,
      object: new FollowVocab({
        id: follow.id,
        actor: follow.actorId,
        object: follow.objectId
      })
    })
  )
}

export async function handleUndo(ctx: Ctx, undo: Undo): Promise<void> {
  const object = await undo.getObject()
  if (undo.actorId == null) return

  if (object instanceof FollowVocab) {
    if (object.objectId == null) return
    const target = ctx.parseUri(object.objectId)
    if (target?.type !== 'actor') return
    const localActor = await db.query.federationActor.findFirst({
      where: eq(federationActor.preferredUsername, target.identifier)
    })
    if (!localActor) return
    await db.delete(federationFollower).where(
      and(
        eq(federationFollower.actorId, localActor.id),
        eq(federationFollower.followerActorUri, undo.actorId.href)
      )
    )
    return
  }

  if (object instanceof LikeVocab && object.objectId) {
    await db.delete(federationTimelineEntry).where(
      and(
        eq(federationTimelineEntry.authorActorUri, undo.actorId.href),
        eq(federationTimelineEntry.noteUri, object.objectId.href)
      )
    )
  }
}

export async function handleCreate(ctx: Ctx, create: Create): Promise<void> {
  if (create.actorId == null) return
  const object = await create.getObject()
  if (!(object instanceof Note) || object.id == null) return

  const followRows = await db.query.federationFollow.findMany({
    where: and(
      eq(federationFollow.targetActorUri, create.actorId.href),
      eq(federationFollow.status, 'accepted')
    )
  })
  if (followRows.length === 0) return

  const author = await create.getActor()
  const authorHandle = author ? await getActorHandle(author) : null
  const content = object.content?.toString() ?? ''
  const published = object.published?.toString() ?? new Date().toISOString()

  for (const followRow of followRows) {
    await db.insert(federationTimelineEntry).values({
      id: crypto.randomUUID(),
      actorId: followRow.actorId,
      noteUri: object.id.href,
      authorActorUri: create.actorId.href,
      authorHandle,
      authorName: author?.name?.toString() ?? null,
      content,
      publishedAt: new Date(published)
    }).onConflictDoNothing()
  }
}

export async function handleLike(_ctx: Ctx, like: Like): Promise<void> {
  if (like.actorId == null || like.objectId == null) return
}

export async function handleAccept(_ctx: Ctx, accept: Accept): Promise<void> {
  if (accept.actorId == null) return
  const followObject = await accept.getObject()
  const followActivityId = followObject instanceof FollowVocab ? followObject.id?.href : null
  const remoteActorUri = accept.actorId.href

  const matcher = followActivityId
    ? and(
        eq(federationFollow.followActivityId, followActivityId),
        eq(federationFollow.targetActorUri, remoteActorUri)
      )
    : eq(federationFollow.targetActorUri, remoteActorUri)

  await db.update(federationFollow)
    .set({ status: 'accepted' })
    .where(matcher)
}
