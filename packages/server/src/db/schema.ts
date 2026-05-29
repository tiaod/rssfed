import {
  pgTable,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core"

export const botsTable = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  preferredUsername: text("preferred_username").notNull(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

export const botFeedsTable = pgTable("bot_feeds", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => botsTable.id, { onDelete: "cascade" }),
  feedId: text("feed_id").notNull(),
  lastProcessedEntryId: text("last_processed_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),
  category: text("category"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const userFeedSyncTable = pgTable("user_feed_sync", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),
  lastSyncCursor: text("last_sync_cursor"),
  lastSyncAt: timestamp("last_sync_at"),
})

export const botFollowersTable = pgTable("bot_followers", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => botsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  inboxUrl: text("inbox_url").notNull(),
  sharedInboxUrl: text("shared_inbox_url"),
  followCreatedAt: timestamp("follow_created_at").notNull().defaultNow(),
})

export type Bot = typeof botsTable.$inferSelect
export type NewBot = typeof botsTable.$inferInsert
export type BotFeed = typeof botFeedsTable.$inferSelect
export type UserSubscription = typeof userSubscriptionsTable.$inferSelect
export type BotFollower = typeof botFollowersTable.$inferSelect