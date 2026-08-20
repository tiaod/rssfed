import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"
import { user } from "./auth-schema"

/**
 * 附件元数据表 — 二进制存 S3，这里只存引用与元数据。
 * storageKey 为 S3 对象 key（手填外链 URL 的附件为 null，无文件可删）；
 * 业务表（bots/user）通过外键引用本表，改头像时读旧外键定位 storageKey 再删旧文件。
 */
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey(),
  /** S3 对象 key；手填外链附件为 null（无文件可删） */
  storageKey: text("storage_key"),
  /** 公开访问 URL：上传=S3 public URL，手填=原样保存 */
  url: text("url").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/** 站点全局配置 — 单例行（id 恒为 "site"），管理员维护的站点品牌/外观定制。
 *  权威数据存 PG，离线性由前端 Service Worker 缓存承担（改动频率极低，无需 PouchDB 复制）。
 *  logo 与头像同套路：S3 存文件 + attachments 元数据行，logoUrl 为冗余展示列。 */
export const siteSettings = pgTable("site_settings", {
  id: text("id").primaryKey(),
  siteTitle: text("site_title"),
  description: text("description"),
  /** logo 公开 URL（冗余展示列，浏览器 <img> 直出） */
  logoUrl: text("logo_url"),
  /** logo 附件外键（定位 attachments 行以删除旧 S3 文件） */
  logoAttachmentId: text("logo_attachment_id").references(() => attachments.id, { onDelete: "set null" }),
  /** 主题主色（hex，如 #10b981）；未设置时前端回退内置默认主题 */
  primaryColor: text("primary_color"),
  /** 皮肤标识（占位：皮肤体系尚未定义枚举，先存自由字符串） */
  skin: text("skin"),
  /** 预留扩展项（新配置字段暂写此处，避免频繁改表结构） */
  extras: jsonb("extras").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
})

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
  /** 最后抓到新条目的时间：Worker 抓取到新条目时更新，供前端增量同步判断 */
  lastNewEntryAt: timestamp("last_new_entry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /** 抓取状态：active 正常抓取 / paused 用户暂停（worker 跳过） */
  status: text("status").notNull().default("active"),
  /** 关联的 CouchDB 库名（首次 ensure 时生成随机库名并回写） */
  couchDbName: text("couch_db_name").unique(),
})

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  preferredUsername: text("preferred_username").notNull(),
  /** 头像公开 URL（冗余展示列，同步自附件表，BotKit icon / 前端直出用） */
  avatarUrl: text("avatar_url"),
  /** 头像附件外键（定位 attachments 行以删除旧 S3 文件） */
  avatarAttachmentId: text("avatar_attachment_id").references(() => attachments.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  /** 关联的 CouchDB 产出库名（首次 ensure 时生成随机库名并回写） */
  couchDbName: text("couch_db_name").unique(),
  /** 最后写入新产出的时间：前端据此只同步「上次同步后有过新内容」的 bot */
  lastNewEntryAt: timestamp("last_new_entry_at"),
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

/** Bot 的 ActivityPub 关注者（联邦侧订阅本 bot 的用户） */
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

export const attachmentsRelations = relations(attachments, ({ many }) => ({
  bots: many(bots),
  users: many(user),
  siteSettings: many(siteSettings),
}))

export const siteSettingsRelations = relations(siteSettings, ({ one }) => ({
  logoAttachment: one(attachments, {
    fields: [siteSettings.logoAttachmentId],
    references: [attachments.id],
  }),
}))

export const botsRelations = relations(bots, ({ one, many }) => ({
  user: one(user, {
    fields: [bots.userId],
    references: [user.id],
  }),
  avatarAttachment: one(attachments, {
    fields: [bots.avatarAttachmentId],
    references: [attachments.id],
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
export type Attachment = typeof attachments.$inferSelect
export type NewAttachment = typeof attachments.$inferInsert
export type SiteSettings = typeof siteSettings.$inferSelect
export type NewSiteSettings = typeof siteSettings.$inferInsert
export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type BotFeed = typeof botFeeds.$inferSelect
export type BotFollower = typeof botFollowers.$inferSelect
export type BotFollowing = typeof botFollowing.$inferSelect
export type NewBotFollowing = typeof botFollowing.$inferInsert
export type BotInbox = typeof botInbox.$inferSelect
export type NewBotInbox = typeof botInbox.$inferInsert
