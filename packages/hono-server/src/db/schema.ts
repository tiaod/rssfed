import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
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
  /** 关联的 CouchDB 库名（首次 ensure 时生成随机库名并回写） */
  couchDbName: text("couch_db_name").unique(),
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

/** Bot 出站关注 — bot 关注了哪些联邦宇宙用户 */
export const botFollowing = pgTable("bot_following", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  /** 用户输入的联邦宇宙句柄，如 @alice@example.com */
  handle: text("handle").notNull(),
  /** 对方接受后回填规范 actor URI */
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorAvatar: text("actor_avatar"),
  /** 关注状态：pending 待对方接受 / accepted 已接受 / rejected 被拒绝 */
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("bot_following_bot_id_idx").on(table.botId),
])

/** Bot 收到的动态（inbox）— bot 所关注用户发布的帖子，即 bot 视角的时间线 */
export const botInbox = pgTable("bot_inbox", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  /** 消息 URI，用于去重（对方服务器重试投递时会重复收到同一消息） */
  activityId: text("activity_id").notNull(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name"),
  actorAvatar: text("actor_avatar"),
  content: text("content").notNull(),
  url: text("url"),
  publishedAt: timestamp("published_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("bot_inbox_bot_id_published_idx").on(table.botId, table.publishedAt),
  uniqueIndex("bot_inbox_activity_uniq").on(table.botId, table.activityId),
])

// ── Relations 定义（支持 db.query.* 关系查询）──

export const botsRelations = relations(bots, ({ one, many }) => ({
  user: one(user, {
    fields: [bots.userId],
    references: [user.id],
  }),
  feeds: many(botFeeds),
  followers: many(botFollowers),
  following: many(botFollowing),
  inbox: many(botInbox),
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

export const botFollowingRelations = relations(botFollowing, ({ one }) => ({
  bot: one(bots, {
    fields: [botFollowing.botId],
    references: [bots.id],
  }),
}))

export const botInboxRelations = relations(botInbox, ({ one }) => ({
  bot: one(bots, {
    fields: [botInbox.botId],
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
export type BotFollowing = typeof botFollowing.$inferSelect
export type NewBotFollowing = typeof botFollowing.$inferInsert
export type BotInbox = typeof botInbox.$inferSelect
export type NewBotInbox = typeof botInbox.$inferInsert
export type BotOutbox = typeof botOutbox.$inferSelect
export type NewBotOutbox = typeof botOutbox.$inferInsert
