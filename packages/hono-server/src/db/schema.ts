import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  serial,
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
  /** 深色模式专用 logo 公开 URL；未设置时深色模式继续使用 logoUrl */
  logoDarkUrl: text("logo_dark_url"),
  /** 深色模式 logo 附件外键（定位 attachments 行以删除旧 S3 文件） */
  logoDarkAttachmentId: text("logo_dark_attachment_id").references(() => attachments.id, { onDelete: "set null" }),
  /** 主题主色（hex，如 #10b981）；未设置时前端回退内置默认主题 */
  primaryColor: text("primary_color"),
  /** 皮肤标识（占位：皮肤体系尚未定义枚举，先存自由字符串） */
  skin: text("skin"),

  // ── PWA（可安装到手机）专项配置 ─────────────────────────────────────────
  // 由 /api/site-settings/manifest.webmanifest 动态渲染 Web App Manifest，
  // 全部字段留空时回退 siteTitle / primaryColor / 内置默认图标，保证开箱即可安装。
  /** 主屏幕图标下的短名（建议 ≤12 字符）；未设置时回退 siteTitle */
  pwaShortName: text("pwa_short_name"),
  /** 显示模式：standalone | minimal-ui | fullscreen | browser；未设置时 standalone */
  pwaDisplay: text("pwa_display"),
  /** manifest 的 theme_color（hex）；未设置时回退 primaryColor */
  pwaThemeColor: text("pwa_theme_color"),
  /** manifest 的 background_color，同时用作图标底色（hex，须不透明）；未设置时回退 primaryColor */
  pwaBackgroundColor: text("pwa_background_color"),
  /** PWA 方形图标公开 URL。与 logoUrl 分开：站点 logo 多为横版，裁方会变形或被切字 */
  pwaIconUrl: text("pwa_icon_url"),
  /** PWA 图标附件外键（定位 attachments 行以删除旧 S3 文件） */
  pwaIconAttachmentId: text("pwa_icon_attachment_id").references(() => attachments.id, { onDelete: "set null" }),

  /** 正文 <iframe> 第三方白名单（网址前缀，见 src/iframe-whitelist.ts）。
   *  与订阅源同源的嵌入无需登记；本列为 null 时回退内置默认，空数组表示不放行任何第三方嵌入。 */
  iframeWhitelist: jsonb("iframe_whitelist").$type<string[]>(),

  /** 预留扩展项（新配置字段暂写此处，避免频繁改表结构） */
  extras: jsonb("extras").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
})

/** 用户个人 API token — 供 MCP / 外部客户端以 Bearer 认证访问订阅数据。
 *  只存 token 的 SHA-256 hash，明文仅在创建时返回一次（与密码同规格的不可逆存储）。 */
export const apiToken = pgTable("api_token", {
  id: text("id").primaryKey(),
  /** 所属用户 */
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** 可读名称，如 "claude-desktop" */
  name: text("name").notNull(),
  /** token 明文前缀（用于用户侧识别展示，如 rssfed_xxxx…），非完整 token */
  prefix: text("prefix").notNull(),
  /** SHA-256 hash，唯一索引 */
  tokenHash: text("token_hash").notNull().unique(),
  /** 最近一次使用时间（便于用户排查 / 清理） */
  lastUsedAt: timestamp("last_used_at"),
  /** 过期时间；为 NULL 表示不过期 */
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("api_token_user_id_idx").on(table.userId),
])

/**
 * 每用户的时间线设置。
 *
 * 权威在 PostgreSQL：服务端读它决定「要不要给这个用户的抓取让步」，客户端只镜像到
 * localStorage 供离线显示（设置页的写入走 PATCH /api/timeline/settings）。
 * **没有行 = 全部走全局默认**（见 services/timeline.ts 的 DEFAULT_TIMELINE_SETTINGS），
 * 所以列一律可空。
 *
 * 这里**没有图片参数**：图片策略是抓取时的全局默认（见 rss/entry-images.ts），
 * 用户设置改不了附件。
 *
 * 也**没有同步窗口 / 保底条数**：每源留多少条由 `(用户 × 源)` 的自适应保留策略决定，
 * 存在用户库的 `_local/schedule` 文档里（见 services/owner-schedule.ts）。
 */
export const userTimelineSettings = pgTable("user_timeline_settings", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /**
   * 是否为该用户生成 AI 总结（null/false = 不生成）。
   * 本轮只落存储位与 timeline 文档上的 `aiSummary` 字段，生成链路（LLM provider、
   * 队列、重试）后续接入时不需要再改数据结构。
   */
  aiSummaryEnabled: boolean("ai_summary_enabled"),

  // ── 休眠用户（见 services/timeline-lifecycle.ts）──────────────────────────
  // 新模型下用户库就是唯一真相、没有「派生库」可重建：休眠只是**停止为他抓取**，
  // 省下 egress 与写库。回来时不需要任何重建 —— 下一轮调度照常抓他订阅的源，
  // 本地缺的内容随这次抓取补上。
  /** 最近一次客户端调用时间线接口的时刻（上报有节流，只用于判断休眠） */
  lastActiveAt: timestamp("last_active_at"),
  /** 非空 = 已休眠暂停抓取；下次打开应用时置空 */
  aggregationPausedAt: timestamp("aggregation_paused_at"),

  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 每用户一行的「抓取心跳」—— 最近一轮抓取是什么时候、连续多少轮什么都没发生。
 *
 * 为什么单独一张表而不是往流水里记：抓取一轮几百个源，绝大多数轮次什么都不会发生。
 * 全记成流水会把有价值的事件淹掉；但完全不记又看不见"抓取到底还在不在跑"。
 * 所以空转只更新这一行（每用户一行、覆盖写），流水按轮次记（见 services/timeline-events.ts）。
 */
export const timelineReconcileHeartbeat = pgTable("timeline_reconcile_heartbeat", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /** 最近一轮抓取的完成时刻（不论有没有事发生） */
  at: timestamp("at").notNull().defaultNow(),
  /** 连续多少轮"无事发生"；有新增/裁剪/失败的那一轮清零 */
  quietRounds: integer("quiet_rounds").notNull().default(0),
}, (table) => [
  // 主键就是 userId，不需要额外索引
  index("timeline_reconcile_heartbeat_at_idx").on(table.at),
])

/**
 * 抓取的**轮次流水** —— 设置页「同步日志」直接读它。
 *
 * 为什么单独存一张表，而不是往控制台打日志：抓取结果只由服务端产生，用户在浏览器里看不到
 * "这一轮订阅了多少源、几个到期、新增与裁剪了多少条、哪些源失败了"。把每轮结论落一行留档，
 * 排查"我的时间线怎么不动了"时不用再翻服务端控制台。
 *
 * 刻意**不**给每个源都记一条（一轮几百条会把流水刷爆）：源级的"现在什么状态"（上次抓取时刻、
 * 连续失败次数）随抓取写在用户库的 `_local/schedule` 里，客户端经订阅列表接口读取，
 * 不在这里重复一份。每用户只保留最近 `TIMELINE_EVENT_KEEP` 条（见 services/timeline-events.ts）。
 */
export const timelineEvents = pgTable("timeline_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  at: timestamp("at").notNull().defaultNow(),
  /**
   * fetch（一轮抓取）。历史行还可能是重构前的 reconcile / rebuild / source-sync / error，
   * 客户端按原标签显示，新行不再产生这些。
   */
  kind: text("kind").notNull(),
  /** info / warn / error */
  level: text("level").notNull().default("info"),
  /** 给人看的一句话（中文、短），客户端直接展示 */
  message: text("message").notNull(),
  /** 结构化补充（本轮 sources / due / 新增 / 裁剪 / 失败 与耗时），客户端可展开看 */
  data: jsonb("data"),
}, (table) => [
  // 「某用户最近 N 条」是唯一的查询形态
  index("timeline_events_user_id_idx").on(table.userId, table.id),
])

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * 联邦标识符 `@username@域名`。ActivityPub 的 acct 语义要求它全局唯一，
   * 所以必须有唯一约束：重名会让两个 Bot 争抢同一个联邦身份，而 Fedify 的 KV
   * 又是按 username 存放 actor 密钥对的，同名重建会直接复用旧私钥。
   */
  preferredUsername: text("preferred_username").notNull().unique(),
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

/**
 * Bot 关联的订阅源。
 *
 * ## 为什么这里存 `url` 而不只是 `feedId`
 *
 * 已经没有共享的 `feed_*` 库与 `feeds` 注册表了：抓取按 **owner**（用户 / Bot）各自进行，
 * 直接写进各自的 CouchDB 库。Bot 要被调度抓取，就必须自己带一份「抓什么地址」——
 * 这张表就是 Bot 那侧的订阅来源，`url` 是它的抓取目标。
 *
 * `feedId` 仍保留并与 `deriveFeedId(url)` 一致：条目的 doc id 形如 `entry:{feedId}:{hash}`，
 * 换成 URL 就无法与用户库里的同名条目对齐（同一篇内容在 Bot 库里也叫这个名字）。
 *
 * 与用户订阅的区别：用户的订阅在用户库里（`subscription:` 文档，离线可改），
 * Bot 没有客户端可写形态，所以放在 PG 是合理的 —— 它不会被离线合并，也不存在投影漂移。
 */
export const botFeeds = pgTable("bot_feeds", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  /** 条目前缀用的源 id：`deriveFeedId(url)` */
  feedId: text("feed_id").notNull(),
  /** 抓取地址（Bot 自力抓取的唯一依据） */
  url: text("url").notNull(),
  /** 展示名；抓取成功后由 FeedDoc 更新，失败时作为兜底标题 */
  title: text("title").notNull(),
  /** 用户暂停了这个源针对该 Bot 的抓取（true = 不抓） */
  paused: boolean("paused").notNull().default(false),
  lastProcessedEntryId: text("last_processed_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("bot_feeds_bot_id_idx").on(table.botId),
  // 一个 Bot 对同一个源只有一条关联（重复关联幂等）
  uniqueIndex("bot_feeds_bot_url_uniq").on(table.botId, table.url),
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

export type UserTimelineSettings = typeof userTimelineSettings.$inferSelect
export type NewUserTimelineSettings = typeof userTimelineSettings.$inferInsert
export type ApiToken = typeof apiToken.$inferSelect
export type NewApiToken = typeof apiToken.$inferInsert
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
