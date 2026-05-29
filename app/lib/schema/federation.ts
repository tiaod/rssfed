import { relations } from 'drizzle-orm'
import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth'

export const federationActor = pgTable(
  'federation_actor',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    preferredUsername: text('preferred_username').notNull().unique(),
    name: text('name'),
    summary: text('summary'),
    iconUrl: text('icon_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    uniqueIndex('federation_actor_username_idx').on(table.preferredUsername),
    index('federation_actor_userId_idx').on(table.userId)
  ]
)

export const federationActorKey = pgTable(
  'federation_actor_key',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .notNull()
      .references(() => federationActor.id, { onDelete: 'cascade' }),
    keyType: text('key_type').notNull(),
    publicKey: text('public_key').notNull(),
    privateKey: text('private_key').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  table => [
    index('federation_actor_key_actorId_idx').on(table.actorId)
  ]
)

export const federationFollow = pgTable(
  'federation_follow',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .notNull()
      .references(() => federationActor.id, { onDelete: 'cascade' }),
    targetActorUri: text('target_actor_uri').notNull(),
    targetHandle: text('target_handle'),
    targetName: text('target_name'),
    targetInboxUrl: text('target_inbox_url'),
    targetSharedInboxUrl: text('target_shared_inbox_url'),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] }).default('pending').notNull(),
    followActivityId: text('follow_activity_id'),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  table => [
    index('federation_follow_actorId_idx').on(table.actorId),
    index('federation_follow_status_idx').on(table.status)
  ]
)

export const federationFollower = pgTable(
  'federation_follower',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .notNull()
      .references(() => federationActor.id, { onDelete: 'cascade' }),
    followerActorUri: text('follower_actor_uri').notNull(),
    followerHandle: text('follower_handle'),
    followerName: text('follower_name'),
    followerInboxUrl: text('follower_inbox_url'),
    followerSharedInboxUrl: text('follower_shared_inbox_url'),
    followerUrl: text('follower_url'),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  table => [
    index('federation_follower_actorId_idx').on(table.actorId),
    uniqueIndex('federation_follower_uri_uidx').on(table.actorId, table.followerActorUri)
  ]
)

export const federationTimelineEntry = pgTable(
  'federation_timeline_entry',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .notNull()
      .references(() => federationActor.id, { onDelete: 'cascade' }),
    noteUri: text('note_uri').notNull().unique(),
    authorActorUri: text('author_actor_uri').notNull(),
    authorHandle: text('author_handle'),
    authorName: text('author_name'),
    content: text('content'),
    publishedAt: timestamp('published_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  table => [
    index('federation_timeline_entry_actorId_idx').on(table.actorId),
    index('federation_timeline_entry_publishedAt_idx').on(table.publishedAt)
  ]
)

export const federationActivity = pgTable(
  'federation_activity',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .references(() => federationActor.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    activityUri: text('activity_uri'),
    objectUri: text('object_uri'),
    raw: text('raw'),
    direction: text('direction', { enum: ['inbox', 'outbox'] }).notNull(),
    published: timestamp('published').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  table => [
    index('federation_activity_actorId_idx').on(table.actorId),
    index('federation_activity_type_idx').on(table.type),
    index('federation_activity_direction_idx').on(table.direction)
  ]
)

export const federationActorRelations = relations(federationActor, ({ one, many }) => ({
  user: one(user, {
    fields: [federationActor.userId],
    references: [user.id]
  }),
  keys: many(federationActorKey),
  following: many(federationFollow),
  followers: many(federationFollower),
  timelineEntries: many(federationTimelineEntry),
  activities: many(federationActivity)
}))

export const federationActorKeyRelations = relations(federationActorKey, ({ one }) => ({
  actor: one(federationActor, {
    fields: [federationActorKey.actorId],
    references: [federationActor.id]
  })
}))

export const federationFollowRelations = relations(federationFollow, ({ one }) => ({
  actor: one(federationActor, {
    fields: [federationFollow.actorId],
    references: [federationActor.id]
  })
}))

export const federationFollowerRelations = relations(federationFollower, ({ one }) => ({
  actor: one(federationActor, {
    fields: [federationFollower.actorId],
    references: [federationActor.id]
  })
}))

export const federationTimelineEntryRelations = relations(federationTimelineEntry, ({ one }) => ({
  actor: one(federationActor, {
    fields: [federationTimelineEntry.actorId],
    references: [federationActor.id]
  })
}))
