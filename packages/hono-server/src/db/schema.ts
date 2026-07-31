import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"
import { user } from "./auth-schema"

/** Feed 注册表 — 记录所有已知订阅源的元数据，供 Worker 定时抓取 */
export const feeds = pgTable("feeds", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  siteUrl: text("site_url"),
  image: text("image"),
  errorMessage: text("error_message"),
  lastFetchedAt: timestamp("last_fetched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  preferredUsername: text("preferred_username").notNull(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("bots_user_id_idx").on(table.userId),
])

export const botFeeds = pgTable("bot_feeds", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  feedId: text("feed_id").notNull(),
  lastProcessedEntryId: text("last_processed_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("bot_feeds_bot_id_idx").on(table.botId),
  index("bot_feeds_feed_id_idx").on(table.feedId),
])

/** Bot 出站队列 — Worker 抓取新条目时写入，供 ActivityPub outbox 查询 */
export const botOutbox = pgTable("bot_outbox", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  entryId: text("entry_id").notNull(),
  feedId: text("feed_id").notNull(),
  /** 推送的 ActivityPub Activity ID */
  activityId: text("activity_id"),
  title: text("title").notNull(),
  url: text("url"),
  publishedAt: timestamp("published_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("bot_outbox_bot_id_idx").on(table.botId),
  index("bot_outbox_published_at_idx").on(table.publishedAt),
])

export const botFollowers = pgTable("bot_followers", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  inboxUrl: text("inbox_url").notNull(),
  sharedInboxUrl: text("shared_inbox_url"),
  followCreatedAt: timestamp("follow_created_at").notNull().defaultNow(),
}, (table) => [
  index("bot_followers_bot_id_idx").on(table.botId),
])

// ── Relations 定义（支持 db.query.* 关系查询）──

export const botsRelations = relations(bots, ({ one, many }) => ({
  user: one(user, {
    fields: [bots.userId],
    references: [user.id],
  }),
  feeds: many(botFeeds),
  followers: many(botFollowers),
}))

export const botFeedsRelations = relations(botFeeds, ({ one }) => ({
  bot: one(bots, {
    fields: [botFeeds.botId],
    references: [bots.id],
  }),
}))

export const botFollowersRelations = relations(botFollowers, ({ one }) => ({
  bot: one(bots, {
    fields: [botFollowers.botId],
    references: [bots.id],
  }),
}))

// ── 类型导出 ──

export type Feed = typeof feeds.$inferSelect
export type NewFeed = typeof feeds.$inferInsert
export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type BotFeed = typeof botFeeds.$inferSelect
export type BotFollower = typeof botFollowers.$inferSelect
export type BotOutbox = typeof botOutbox.$inferSelect
export type NewBotOutbox = typeof botOutbox.$inferInsert
