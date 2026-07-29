import {
  pgTable,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core"

export const bots = pgTable("bots", {
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

export const botFeeds = pgTable("bot_feeds", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  feedId: text("feed_id").notNull(),
  lastProcessedEntryId: text("last_processed_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const userSubscriptions = pgTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),
  category: text("category"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const userFeedSync = pgTable("user_feed_sync", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),
  lastSyncCursor: text("last_sync_cursor"),
  lastSyncAt: timestamp("last_sync_at"),
})

export const botFollowers = pgTable("bot_followers", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  inboxUrl: text("inbox_url").notNull(),
  sharedInboxUrl: text("shared_inbox_url"),
  followCreatedAt: timestamp("follow_created_at").notNull().defaultNow(),
})

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type BotFeed = typeof botFeeds.$inferSelect
export type UserSubscription = typeof userSubscriptions.$inferSelect
export type BotFollower = typeof botFollowers.$inferSelect