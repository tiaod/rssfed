# RSSFed 架构设计文档

## 项目概述

RSSFed 是一个支持 ActivityPub 的 RSS 阅读器，核心功能：

1. RSS 定时抓取与存储（自实现，不使用 Miniflux）
2. 用户订阅管理与离线阅读（CouchDB + PouchDB 同步）
3. ActivityPub 机器人自动转发 RSS 内容到 Fediverse

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 包管理 | pnpm workspace (monorepo) | >=10 |
| 运行时 | Node.js | >=20 |
| API 框架 | Hono | ^4.7 |
| ActivityPub | Fedify (`@fedify/fedify`) | ^1.10 |
| 身份认证 | Better Auth | ^1.2 |
| ORM | Drizzle ORM (code-first) | ^0.45 |
| 关系数据库 | PostgreSQL (prod) / pg (dev) | |
| 文档数据库 | CouchDB 3.x | |
| 客户端离线 | PouchDB | ^9.0 |
| 任务队列 | BullMQ (Redis) | ^5.0 |
| RSS 解析 | rss-parser | ^3.13 |
| 前端框架 | Nuxt | ^4 |
| UI 组件库 | Nuxt UI | ^4 |



---

## 身份认证架构

### 核心原则：Only One Server

Better Auth 采用**客户端-服务器**模式，整个系统只有一个服务器实例。

```
┌──────────────────────────────────────────────────────────┐
│                   反向代理 (nginx / Caddy)                │
│              https://rssfed.example.com                   │
│                                                          │
│  /api/*     → Hono  (localhost:3001)    ← Auth Server    │
│  /*         → Nuxt  (localhost:3000)    ← SSR 渲染        │
└──────────────────────────────────────────────────────────┘

Nuxt 的 Nitro 通过 routeRules 将 /api/* 代理到 Hono（开发模式）
生产环境使用反向代理统一域名，cookie 自动同域
```

| 组件 | Better Auth 角色 | 说明 |
|------|-----------------|------|
| **Hono** | **Server** | 唯一拥有 `betterAuth()` 实例，负责认证、session、cookie |
| **Nuxt** | **Client only** | 只使用 `better-auth/vue` 客户端 SDK，无 handler 实例 |

### Hono 端配置

```typescript
// apps/server/src/auth.ts
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "./db"

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  advanced: {
    crossSubDomainCookies: { enabled: true },
  },
})

// apps/server/src/index.ts
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"

const app = new Hono()

app.use("/api/*", cors({
  origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  credentials: true,
}))

// Better Auth handler 挂载到 /api/auth/*
app.use("/api/auth/*", async (c) => {
  return auth.handler(c.req.raw)
})

app.route("/api/feeds", feedsRouter)
app.route("/api/bots", botsRouter)
app.route("/api/sync", syncRouter)
app.route("/api/subscriptions", subscriptionsRouter)

app.get("/api/health", (c) => c.json({ status: "ok" }))

// Fedify ActivityPub middleware (bot 已合并到 server)
app.use("/", fediMiddleware)

serve({ fetch: app.fetch, port: parseInt(process.env.PORT ?? "3001") })
```

### Nuxt 端配置

```typescript
// apps/nuxt/app/lib/auth-client.ts
import { createAuthClient } from "better-auth/vue"

// 指向 Hono API 服务（通过 Nuxt Nitro proxy 转发）
export const authClient = createAuthClient({
  baseURL: useRuntimeConfig().public.apiBaseUrl,
})
```

Nuxt 的 `nuxt.config.ts` 通过 Nitro 的 `routeRules` 代理 API 请求到 Hono:

```typescript
// apps/nuxt/nuxt.config.ts
nitro: {
  routeRules: {
    "/api/**": { proxy: "http://localhost:3001" },
  },
},
```

### SSR 认证

```vue
<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

// SSR 时传入 useFetch，服务端也能获取 session（通过 proxy 转发 cookie）
const { data: session } = await authClient.useSession(useFetch)
</script>
```

### 路由保护

```typescript
// apps/nuxt/app/middleware/auth.ts
import { authClient } from "~/lib/auth-client"

export default defineNuxtRouteMiddleware(async (to) => {
  const { data: session } = await authClient.useSession(useFetch)
  if (!session.value) {
    return navigateTo({ path: "/login", query: { redirect: to.fullPath } })
  }
})
```

---

## 双数据库职责划分

| 数据库 | 存储内容 | 用途 |
|--------|----------|------|
| **Drizzle ORM (PostgreSQL)** | 用户、bots、bot-feed 关系、用户订阅关系、同步元数据 | 核心业务逻辑、身份验证、ActivityPub 管理 |
| **CouchDB Global** | feeds、entries（全局唯一） | RSS 内容权威来源 |
| **CouchDB Per User** | 用户的订阅条目缓存 + read/saved 状态 | 离线阅读、PouchDB 同步 |

---

## 数据库设计

### Drizzle ORM 数据模型

```typescript
// apps/server/src/db/schema.ts （使用 pgTable, 非 sqliteTable）

// Bot 表 - ActivityPub 机器人
export const botsTable = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),          // 关联 Better Auth 用户
  name: text("name").notNull(),
  description: text("description"),
  preferredUsername: text("preferred_username").notNull(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Bot-Feed 关系表 - 机器人订阅哪些 feeds
export const botFeedsTable = pgTable("bot_feeds", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => botsTable.id, { onDelete: "cascade" }),
  feedId: text("feed_id").notNull(),                  // 对应 CouchDB feed:${id}
  lastProcessedEntryId: text("last_processed_entry_id"),  // 上次转发到的条目
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 用户订阅表
export const userSubscriptionsTable = pgTable("user_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),                 // 对应 CouchDB feed:${id}
  category: text("category"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 用户-Feed 同步进度表
export const userFeedSyncTable = pgTable("user_feed_sync", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  feedId: text("feed_id").notNull(),
  lastSyncCursor: text("last_sync_cursor"),            // 上次同步到的 entry id
  lastSyncAt: timestamp("last_sync_at"),
});

// Bot-Follower 表 - ActivityPub 关注者
export const botFollowersTable = pgTable("bot_followers", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => botsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),                // Fediverse actor URI
  inboxUrl: text("inbox_url").notNull(),
  sharedInboxUrl: text("shared_inbox_url"),
  followCreatedAt: timestamp("follow_created_at").notNull().defaultNow(),
});
```

> 注意：`boolean()` 和 `timestamp()` 是 `drizzle-orm/pg-core` 特有的 API，如果在 SQLite 环境下应改用 `integer("col", { mode: "boolean" })` 和 `integer("col", { mode: "timestamp_ms" })`.

### CouchDB 文档设计

```typescript
// CouchDB Global - 所有 RSS 数据全局唯一

// Feed 文档
interface FeedDoc {
  _id: string;             // "feed:${base64(url).slice(0,12)}"
  _rev?: string;
  type: "feed";
  url: string;
  title: string;
  description?: string;
  siteUrl?: string;
  image?: string;
  errorMessage?: string;
  lastFetchedAt: string;   // ISO 8601
  createdAt: string;
}

// Entry 文档
interface EntryDoc {
  _id: string;             // "entry:${feedId}:${sha256(guid).slice(0,12)}"
  _rev?: string;
  type: "entry";
  feedId: string;
  url: string;
  title: string;
  content?: string;
  description?: string;
  guid: string;
  author?: string;
  authorUrl?: string;
  authorAvatar?: string;
  publishedAt: string;     // ISO 8601
  insertedAt: string;      // 数据入库时间
  categories?: string[];
  media?: MediaModel[];
  attachments?: AttachmentModel[];
}
```

CouchDB 设计文档（需手动安装到 Global DB）：

```json
{
  "_id": "_design/main",
  "language": "javascript",
  "filters": {
    "entries-by-feeds": "function(doc, req) {
      if (doc.type !== 'entry') return false;
      var feedIds = JSON.parse(req.query.feed_ids || '[]');
      return feedIds.indexOf(doc.feedId) !== -1;
    }",
    "entries-by-feed": "function(doc, req) {
      if (doc.type !== 'entry') return false;
      return doc.feedId === req.query.feed_id;
    }"
  },
  "views": {
    "entries-by-feed": {
      "map": "function(doc) { if (doc.type === 'entry') emit(doc.feedId, {_id: doc._id}); }"
    },
    "entries-by-date": {
      "map": "function(doc) { if (doc.type === 'entry') emit(doc.publishedAt, null); }"
    },
    "feeds-all": {
      "map": "function(doc) { if (doc.type === 'feed') emit(doc._id, null); }"
    }
  }
}

// CouchDB Per User - 用户私有缓存 + 状态
// 每次同步时从 Global 过滤复制 entry，然后用户在本地标记 read/saved

interface UserEntryDoc {
  _id: string;             // "entry:${feedId}:${hash}" (与 Global 一致)
  _rev?: string;
  type: "entry";
  feedId: string;
  // ... 从 Global 同步过来的数据相同
  read: boolean;           // 用户私有 - 已读状态
  readAt?: string;         // 用户私有 - 已读时间
  saved: boolean;          // 用户私有 - 收藏
}
```

---

## 数据流

### 1. RSS 抓取流程

```
用户/系统触发 feed 发现 (POST /api/feeds/discover)
    │
    ├─ rss-parser 解析 RSS/Atom
    │
    ├─ 计算 feedId: "feed:${base64(url).slice(0,12)}"
    │
    └─ 写入 Global CouchDB
       ├─ feed 文档 (upsert)
       └─ 后续由 BullMQ Worker 定时更新

BullMQ Worker (定时调度 - 待实现)
    │
    ├─ 从 Drizzle 读取所有 feed url 列表
    ├─ 每 N 分钟调度一批抓取任务
    ├─ rss-parser 解析 RSS/Atom
    ├─ 去重：检查 Global CouchDB 中是否已存在相同 entry
    └─ 写入 Global CouchDB: 批量写入新 entries
```

### 2. 用户同步流程（用户触发）

```
用户打开应用
    ↓
1. 从 Drizzle 查询用户订阅的 feedId 列表 (GET /api/subscriptions)
    ↓
2. 调用 sync API 触发同步 (POST /api/sync)
    ↓
3. 服务端 PouchDB 过滤复制：Global DB → User DB
   - 只同步用户订阅的 feedId 对应的 entries
   - 使用 CouchDB filter 函数过滤
   - 分页拉取，batch_size = 500
    ↓
4. 记录同步进度到 Drizzle user_feed_sync 表
    ↓
5. 用户本地 PouchDB 同步 User CouchDB
   - 双向实时同步（本地已读标记推回云端）
```

### 3. 离线阅读流程

```
用户在线时
    ↓
本地 PouchDB 同步 User CouchDB
    ↓
用户离线
    ↓
读本地 PouchDB，所有数据可用
标记已读 → 写入本地 PouchDB
    ↓
用户联网
    ↓
PouchDB 自动同步到 User CouchDB（后台静默）
```

### 4. ActivityPub 转发流程

```
`apps/server` 中 bots/index.ts 定时轮询（默认每 5 分钟）
    │
    ├─ 从 Drizzle 查询所有 active 的 bots 及其关联的 feeds
    │
    ├─ 对于每个 (bot, feed) 对：
    │   ├─ 查询 Global CouchDB 该 feed 是否有新条目
    │   │  (比较 lastProcessedEntryId)
    │   ├─ 有新条目 → 构建 Note + Create Activity
    │   └─ 发送到所有 follower 的 inbox
    │
    └─ Fedify 自动处理：
       ├─ WebFinger 发现 (/.well-known/webfinger)
       ├─ HTTP Signatures 签名验证
       └─ Actor 信息 (Service 类型)

注意：ActivityPub 与 Hono API 运行在同一个进程（端口 3001），
Fedify 通过 @fedify/hono 的 federation() 中间件集成。
Bot 转发逻辑在 apps/server/src/bots/index.ts 中使用 setInterval 定期执行，
非独立服务，不需要额外端口。
```

### 5. 新用户第一次打开应用

```
注册/登录 (Better Auth)
    ↓
Guide: 推荐热门 feeds / 搜索 / 导入 OPML
    ↓
订阅 feed → 写入 Drizzle user_subscriptions
    ↓
触发 sync API → 后台创建 User CouchDB 数据库
    ↓
过滤同步 Global DB → User DB
```

---

## 环境变量

| 变量名 | 默认值 | 所属服务 | 说明 |
|--------|--------|----------|------|
| `PORT` | `3001` | `@rssfed/server` | Hono API 端口 |
| `DATABASE_URL` | `postgres://localhost:5432/rssfed` | `@rssfed/server` | PostgreSQL 连接串 |
| `COUCHDB_URL` | `http://localhost:5984` | `@rssfed/server` | CouchDB 地址 |
| `REDIS_HOST` | `localhost` | `@rssfed/server` | Redis 地址 |
| `REDIS_PORT` | `6379` | `@rssfed/server` | Redis 端口 |
| `CORS_ORIGIN` | `http://localhost:3000` | `@rssfed/server` | CORS 允许的源 |
| `BOTS_BASE_URL` | `http://localhost:3001` | `@rssfed/server` | Fedify Bot 公网地址（与 server 同进程） |
| `CHECK_INTERVAL` | `300000` | `@rssfed/server` | Bot 轮询间隔 (ms) |
| `FETCH_INTERVAL` | `900000` | `@rssfed/server` | RSS 抓取调度间隔 (ms, 默认 15 分钟) |
| `API_BASE_URL` | `http://localhost:3001` | `@rssfed/nuxt` | Nuxt 代理的 API 地址 |

---

## 项目目录结构（实际）

```
rssfed/
├── apps/
│   ├── server/              # Hono API 服务 (Auth + 业务 API + Fedify Bot)
│   │   ├── src/
│   │   │   ├── index.ts          # 入口：挂载 auth handler + 路由 + Fedify 中间件 + serve()
│   │   │   ├── auth.ts           # Better Auth 服务端配置 (唯一实例)
│   │   │   ├── db/               # Drizzle schema + 类型 + 常量 (本地模块)
│   │   │   │   ├── index.ts          # re-export: db 实例 + schema + types + constants
│   │   │   │   ├── schema.ts         # pgTable 定义 (bots, bot_feeds, subscriptions, etc.)
│   │   │   │   ├── types.ts          # FeedDoc, EntryDoc, UserEntryDoc, BotConfig
│   │   │   │   └── constants.ts      # COUCHDB_GLOBAL, SYNC_BATCH_SIZE, CLEANUP_DAYS
│   │   │   ├── bots/             # ActivityPub Bot (Fedify, 已合并到 server)
│   │   │   │   └── index.ts      # createFederation + Actor + Inbox + 轮询转发
│   │   │   ├── couchdb/          # CouchDB 客户端 (nano + PouchDB)
│   │   │   │   └── client.ts     # ensureGlobalDatabase, ensureUserDatabase
│   │   │   ├── routes/
│   │   │   │   ├── feeds.ts      # POST /discover, GET /:feedId
│   │   │   │   ├── sync.ts       # POST / 触发同步, GET /status
│   │   │   │   ├── bots.ts       # Bot CRUD + Feed 关联
│   │   │   │   └── subscriptions.ts  # 订阅增删查
│   │   │   ├── rss/
│   │   │   │   └── parser.ts     # rss-parser 实例
│   │   │   └── workers/
│   │   │       └── index.ts      # BullMQ Queue + Worker + 定时调度
│   │   ├── drizzle.config.ts        # drizzle-kit 配置
│   │   ├── package.json             # hono, better-auth, @fedify/fedify, drizzle-orm, nano, bullmq
│   │   └── tsconfig.json
│   └── nuxt/                   # Nuxt 前端 (SSR + Nuxt UI)
│       ├── app/
│       │   ├── app.vue             # 根组件
│       │   ├── lib/
│       │   │   └── auth-client.ts   # Better Auth 客户端 (useRuntimeConfig)
│       │   ├── pages/
│       │   │   ├── index.vue       # 首页（展示 session 状态）
│       │   │   └── login.vue       # 登录/注册页
│       │   ├── middleware/
│       │   │   └── auth.ts         # 路由保护中间件
│       │   └── layouts/
│       │       └── default.vue     # 默认布局
│       ├── nuxt.config.ts          # @nuxt/ui 模块 + Nitro proxy
│       ├── package.json            # nuxt, @nuxt/ui, better-auth/vue
│       └── tsconfig.json
├── tsconfig.base.json              # 基础 tsconfig（根目录）
├── .gitignore
├── .npmrc
├── pnpm-workspace.yaml
├── package.json                    # root scripts: dev, dev:all, typecheck, db:push
└── ARCHITECTURE.md                 # 本文件
```

---

## API 端点

### 业务 API (Hono) — 端口 3001

| 方法 | 路径 | 说明 |
|------|------|------|
| 所有 | `/api/auth/*` | Better Auth 认证路由 (sign in/up/out, session) |
| POST | `/api/feeds/discover` | 发现并解析 RSS feed (返回 feedId + title) |
| GET | `/api/feeds/:feedId` | 查询 feed 详情 |
| POST | `/api/subscriptions` | 订阅 feed |
| DELETE | `/api/subscriptions` | 取消订阅 |
| GET | `/api/subscriptions?userId=` | 获取用户订阅列表 |
| POST | `/api/sync` | 触发 Global → User DB 同步 |
| GET | `/api/sync/status` | 同步进度查询 |
| POST | `/api/bots` | 创建机器人 |
| GET | `/api/bots?userId=` | 我的机器人列表 |
| PUT | `/api/bots/:id` | 更新机器人配置 |
| DELETE | `/api/bots/:id` | 删除机器人 |
| POST | `/api/bots/:id/feeds` | 添加转发 feed |
| DELETE | `/api/bots/:id/feeds/:feedId` | 移除转发 feed |
| GET | `/api/health` | 健康检查 |

### ActivityPub (Fedify) — 同端口 3001（Hono middleware）

| 路径 | 说明 |
|------|------|
| `/.well-known/webfinger` | WebFinger 发现（Fedify 自动处理） |
| `/actor/{botId}` | Bot Actor 信息 (Service 类型) |
| `/actor/{botId}/inbox` | 接收 Follow/Unfollow |
| `/actor/{botId}/outbox` | Bot 发布的 Activity 列表（待实现） |
| `/actor/{botId}/followers` | 关注者列表（待实现） |

> ActivityPub 路由与 Hono API 同端口 (3001)，Fedify 通过 `federation()` 中间件挂载到 `/` 路径。

---

## 数据清理策略

| 清理对象 | 频率 | 策略 |
|----------|------|------|
| User CouchDB entries | 每周 | 删除 30 天前的已读旧条目，但保留收藏(saved=true)的条目 |
| User CouchDB 压缩 | 每周清理后 | CouchDB `_compact` 释放空间 |
| Global CouchDB | 不清理 | 全局存档，所有 feed 的完整数据 |
| Drizzle user_feed_sync | 同步时更新 | 覆盖更新 lastSyncCursor |

清理脚本参考（待实现）：

```typescript
async function cleanupUserDB(userId: string) {
  const userDB = new PouchDB(`https://couch.example.com/rssfed-user:${userId}`);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const stale = await userDB.find({
    selector: { type: 'entry', publishedAt: { $lt: cutoff }, saved: { $ne: true } },
    fields: ['_id', '_rev'],
  });

  if (stale.docs.length === 0) return;
  await userDB.bulkDocs(stale.docs.map(doc => ({ ...doc, _deleted: true })));
  await userDB.compact();
}
```

---

## 数据库管理

### 创建用户数据库

```typescript
// apps/server/src/couchdb/client.ts
export async function ensureUserDatabase(userId: string) {
  const dbName = `rssfed-user:${userId}`;
  try {
    await nanoServer.db.get(dbName);
  } catch {
    await nanoServer.db.create(dbName);
    // 上传 design document（过滤函数等）
    await nanoServer.use(dbName).insert({
      _id: "_design/main",
      filters: {
        "entries-by-feeds": `function(doc, req) {
          if (doc.type !== 'entry') return false;
          var feedIds = JSON.parse(req.query.feed_ids || '[]');
          return feedIds.indexOf(doc.feedId) !== -1;
        }`
      }
    });
  }
}
```

### 跨 DB 同步

```typescript
// apps/server/src/routes/sync.ts 中的过滤复制
async function syncUserFromGlobal(userId: string, feedIds: string[]) {
  const userPouch = getUserPouch(userId);
  const globalPouch = getGlobalPouch();

  await userPouch.replicate.from(globalPouch, {
    filter: (doc: any) => {
      if (doc.type !== "entry") return false;
      return feedIds.includes(doc.feedId);
    },
    batch_size: SYNC_BATCH_SIZE,
  });
}
```

> 注意：这里使用的是 **客户端过滤** (PouchDB filter function)，与 CouchDB 的 `_design/main` 设计文档中的 `filters` 不同。两种方式都可以，后续可以统一为设计文档中的 filter。

---

## 依赖关系

```
@rssfed/server           ← drizzle-orm, postgres, hono, better-auth, @fedify/fedify,
                             @fedify/hono, nano, pouchdb-node, bullmq,
                             rss-parser, ioredis, @hono/node-server
    ↑
@rssfed/nuxt             ← nuxt, @nuxt/ui, better-auth/vue
```

---

## 依赖服务启动

### Docker Compose（参考）

```yaml
version: "3.8"
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: rssfed
      POSTGRES_PASSWORD: rssfed
    ports:
      - "5432:5432"

  couchdb:
    image: couchdb:3
    environment:
      COUCHDB_USER: admin
      COUCHDB_PASSWORD: admin
    ports:
      - "5984:5984"

  redis:
    image: redis:7
    ports:
      - "6379:6379"
```

### 启动顺序

1. PostgreSQL → CouchDB → Redis
2. `pnpm db:push` 同步 Drizzle schema 到 PostgreSQL
3. `pnpm dev` (启动 server, 端口 3001)
4. `pnpm dev:nuxt` (启动 Nuxt, 端口 3000)

> Bot 不再需要独立启动，它已作为 server 的一部分运行在同一进程。

---

## 已知待办项

1. ~~`apps/server` 启动问题 - `index.ts` 缺少 `serve()` 调用和 `@hono/node-server` 依赖~~ ✅ **已修复**
2. ~~**CouchDB design document 安装** - 需要在 server 启动时自动安装 `_design/main` 到 Global DB~~ ✅ **已修复**
3. ~~**BullMQ Worker 实现** - 当前只是占位，需要实现完整的 RSS 定时抓取逻辑~~ ✅ **已修复**
4. **Fedify KV Store 替换** - 当前使用 `MemoryKvStore`，生产环境需换 `RedisKvStore` 或 `PostgresKvStore`
5. **User CouchDB 定期清理** - 需要实现清理 cron job（删除 30 天前的已读旧条目，保留收藏条目 + compact）
6. **Nuxt SSR cookie 传递** - 当前通过 Nitro proxy 解决，生产环境需确保正确