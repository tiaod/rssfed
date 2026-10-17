import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  primaryKey,
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
 * 每用户的时间线聚合设置 — 决定服务端往该用户的 `user-timeline_*` 派生库里写什么。
 *
 * 权威在 PostgreSQL：服务端每次 reconcile 都要读它，而客户端只把它镜到 localStorage
 * 供离线显示（设置页的写入走 PATCH /api/timeline/settings）。**没有行 = 全部走全局默认**
 *（见 services/timeline.ts 的 DEFAULT_TIMELINE_SETTINGS），所以列一律可空。
 *
 * 这里**没有图片参数**：图片策略只有一份 per-feed 的（管理员维护，见 rss/entry-images.ts），
 * 抓取时就压好了；聚合只搬运成品，用户设置改不了附件。
 */
export const userTimelineSettings = pgTable("user_timeline_settings", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /**
   * 是否为该用户生成 AI 总结（null/false = 不生成）。
   * 本轮只落存储位与 timeline 文档上的 `aiSummary` 字段，生成链路（LLM provider、
   * 队列、重试）后续接入时不需要再改数据结构。
   */
  aiSummaryEnabled: boolean("ai_summary_enabled"),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 每个 (用户 × 订阅源) 的**同步水位** —— 决定"这个源现在要不要搬一次"。
 *
 * 背景：聚合早期是每个 (用户 × 源) 一条 **常驻** CouchDB 复制（`continuous: true`）。
 * 常驻任务在这台 2 核机上跑不动：625 条一起追赶会把机器压死（实测 load 20.8、
 * swap 1.6G/2G），而用 `max_jobs` 限流又会饿死 —— 常驻任务永不结束，`max_jobs`
 * 事实上是"最多有多少个源会被搬"，设 50 时 573 个源的内容一条都搬不过来。
 * 现在改成**按需一次性复制**：reconcile 只给"上次同步之后源那边有过新内容"的源入队，
 * 队列限并发地跑一次性复制。本表就是那个"上次同步"的水位。
 *
 * 为什么放 PostgreSQL 而不是用户库里的 `subscription:` 文档：
 *   - `subscription:` 是**客户端也会写**的文档（PouchDB 双向同步），服务端往上写水位会和
 *     用户的订阅编辑撞出修订冲突；
 *   - 放 PG 才能按 `source_id` 反查"谁订阅了这个源"：抓取到新内容时靠它**只叫醒订阅者**
 *     （见 `listSubscriberUserIds`）。早期是给所有用户广播，实测一个零订阅账号 4 小时被
 *     叫醒 332 次、每次都只是空转。
 *
 * 早先这里还存过复制过滤器的"固定下界"（`bound_iso`），现已随「按用户窗口/保底条数」一起
 * 删除：复制不再带任何参数，保留策略的唯一权威是源库裁剪（见 `couchdb/retention.ts`）。
 *
 * `synced_at` 记的是**复制开始**的时刻而不是完成时刻，这是为了堵一个丢数据的竞态：
 * 抓取 worker 在复制进行中写入新条目时，那条变更可能没被本次复制的 `_changes` 读到，
 * 但它的 `lastNewEntryAt` 会比"完成时刻"更早 —— 用完成时刻就会把这条判成"已同步过"，
 * 于是永远不再搬。用开始时刻则它一定还脏，下一轮补上（代价只是一次空转复制）。
 *
 * **行的生命周期**（没有数据库触发器/视图，全部由应用在 reconcile 与同步任务里维护；
 * 订阅集合的权威始终是用户库里的 `subscription:` 文档 —— 客户端也可以写它，见
 * `listSubscriptionSources`）：
 *   - **新增**：reconcile 读到"订阅里有、水位里没有" → 判脏源 → 入队；
 *     **行是那次同步自己 upsert 的**（先写行再搬），不是"订阅那一刻"建的；
 *   - **删除**：退订写回用户库后的第一轮 reconcile 发现"水位里有、订阅里没有" →
 *     删该源条目 + 删行（写回是异步的，点了退订立刻看表里还在是正常的）；
 *   - **随用户删**：`user_id` 上的 `ON DELETE CASCADE`（这一条是数据库兜的）；
 *   - **作废**：聚合库整个换掉（重建、v1→v2 升级、手工删库）→ 清掉该用户全部行
 *     （`isDerivedDbFresh`），否则新库是空的、"源那边没新内容"的源永远不会被搬。
 * 队列里的同步任务还会先复查 `subscription:<sourceId>`：退订发生在入队之后时直接跳过，
 * 不会把刚清掉的内容又搬回来。
 */
export const timelineSourceSync = pgTable("timeline_source_sync", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** 源 id：feeds 的 feedId，或 `bot:{botId}` */
  sourceId: text("source_id").notNull(),
  /** 上次同步**开始**的时刻；与 feeds/bots.lastNewEntryAt 比较决定是否还需要再搬 */
  syncedAt: timestamp("synced_at"),
  /** 上次同步结束时源库的 update_seq（诊断用；不参与判定，避免每源一次 info 请求） */
  sourceSeq: text("source_seq"),
  /** idle（上次同步成功）/ syncing / error */
  status: text("status").notNull().default("idle"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  // 一个用户对一个源只有一行水位（并发入队时靠它做 upsert）
  primaryKey({ columns: [table.userId, table.sourceId] }),
  // 「谁订阅了这个源」的反查索引（将来做定向通知）
  index("timeline_source_sync_source_idx").on(table.sourceId),
])

/**
 * 每用户一行的「聚合心跳」—— 最近一轮聚合是什么时候、连续多少轮什么都没发生。
 *
 * 为什么单独一张表而不是往流水里记：定时器 5 分钟一轮，空转占绝大多数（实测 4 小时里
 * 564/671 条是"无需搬运"）。把它们记成流水会把有价值的事件淹掉；但完全不记又看不见
 * "聚合到底还在不在跑"。所以空转只更新这一行（每用户一行、覆盖写），流水只记真正干了活的轮次。
 */
export const timelineReconcileHeartbeat = pgTable("timeline_reconcile_heartbeat", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /** 最近一轮聚合的完成时刻（不论有没有事发生） */
  at: timestamp("at").notNull().defaultNow(),
  /** 连续多少轮"无事发生"；有搬运/清理/失败的那一轮清零 */
  quietRounds: integer("quiet_rounds").notNull().default(0),
}, (table) => [
  // 主键就是 userId，不需要额外索引
  index("timeline_reconcile_heartbeat_at_idx").on(table.at),
])

/**
 * 用户时间线同步的**事件流水** —— 设置页「同步日志」直接读它。
 *
 * 为什么单独存一张表，而不是往控制台打日志：聚合结果只由服务端产生，用户在浏览器里看不到
 * "什么时候跑了一轮汇聚、判了几个脏源、退订清理了几条、什么时候重建过"。把这些离散动作
 * 落一行留档，排查"我的时间线怎么不动了"时不用再翻服务端控制台。
 *
 * 刻意**不**给每个源同步都记一条（一轮 100+ 条会把流水刷爆）：源级的"现在什么状态"直接读
 * `timeline_source_sync`（它本来就是每源一行），这里只记**离散动作**与失败。
 * 每用户只保留最近 `TIMELINE_EVENT_KEEP` 条（见 services/timeline-events.ts 的裁剪）。
 */
export const timelineEvents = pgTable("timeline_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  at: timestamp("at").notNull().defaultNow(),
  /** reconcile（一轮汇聚）/ rebuild（重建聚合库）/ source-sync（首搬）/ error */
  kind: text("kind").notNull(),
  /** info / warn / error */
  level: text("level").notNull().default("info"),
  /** 给人看的一句话（中文、短），客户端直接展示 */
  message: text("message").notNull(),
  /** 结构化补充（脏源数、耗时、源 id 等），客户端可展开看 */
  data: jsonb("data"),
}, (table) => [
  // 「某用户最近 N 条」是唯一的查询形态
  index("timeline_events_user_id_idx").on(table.userId, table.id),
])

/** Feed 注册表 — 记录所有已知订阅源的元数据，供 Worker 定时抓取 */export const feeds = pgTable("feeds", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  siteUrl: text("site_url"),
  image: text("image"),
  errorMessage: text("error_message"),
  lastFetchedAt: timestamp("last_fetched_at"),
  /** 最后抓到新条目的时间：Worker 抓取到新条目时更新，供前端"最后更新"展示 */
  lastNewEntryAt: timestamp("last_new_entry_at"),
  /**
   * 源库内容**最后一次变化**的时间（新增**或裁剪删除**都算）。
   *
   * 脏源判定用它而不是 `lastNewEntryAt`：裁剪只删不增，只看新增的话删除永远触发不了同步，
   * 用户库里就会永久留一条已从源库裁掉的条目（见
   * `docs/notes/aggregation/source-side-retention-plan.md` §3.3 场景 B）。
   * 回填值 = `last_new_entry_at`；bot 库不裁剪，仍用 `lastNewEntryAt`。
   */
  lastChangedAt: timestamp("last_changed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /** 抓取状态：active 正常抓取 / paused 用户暂停（worker 跳过） */
  status: text("status").notNull().default("active"),
  /** 关联的 CouchDB 库名（首次 ensure 时生成随机库名并回写） */
  couchDbName: text("couch_db_name").unique(),
  // ── 图片缓存 per-feed 策略（管理员可覆盖全局默认，见 rss/entry-images.ts） ──
  /** 是否缓存全部正文图片（如漫画源全量离线；false/null 跟随全局默认限制数量） */
  cacheImages: boolean("cache_images"),
  /** 每篇最多缓存图片数（null=跟随全局默认；cacheImages 开启且未设置时视为不限制） */
  maxImageCount: integer("max_image_count"),
  /** 每篇附件总体积上限字节（null=跟随全局默认 MAX_ENTRY_IMAGE_BYTES，即 1MB） */
  maxEntryImageBytes: integer("max_entry_image_bytes"),
  /** 压缩后最大宽度 px（null=跟随全局默认 MAX_IMAGE_WIDTH） */
  maxImageWidth: integer("max_image_width"),
  /** AVIF 编码质量（null=跟随全局默认 AVIF_QUALITY） */
  avifQuality: integer("avif_quality"),
  /** 源图下载大小上限字节（null=跟随全局默认 MAX_SOURCE_IMAGE_BYTES） */
  maxSourceImageBytes: integer("max_source_image_bytes"),
})

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
