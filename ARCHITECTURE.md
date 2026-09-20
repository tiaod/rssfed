# RSSFed 架构设计

## 项目定位

RSSFed 是一个**离线优先的、基于用户兴趣的资讯聚合与推送工具**，旨在帮助用户在信息爆炸的时代高效地获取自己真正关心的内容。核心能力：

1. **RSS 协议资讯聚合** — 自实现抓取引擎，定时从用户订阅的 Feed 拉取内容（BullMQ 调度 + rss-parser）
2. **离线优先的订阅管理与阅读** — 服务端 CouchDB（每个订阅源独立库）+ 客户端 PouchDB 同步，支持离线缓存、已读/收藏标记，联网后自动合并
3. **ActivityPub 协议内容分发** — 通过 BotKit（基于 Fedify）将聚合的资讯以 ActivityPub 机器人身份自动推送到 Fediverse

## 技术栈概览

| 层级          | 技术                        |
| ----------- | ------------------------- |
| 包管理         | pnpm workspace (monorepo) |
| API 框架      | Hono                      |
| 身份认证        | Better Auth               |
| 关系数据库       | PostgreSQL（Drizzle ORM）   |
| 文档数据库       | CouchDB 3.x               |
| 客户端离线       | PouchDB（浏览器 IndexedDB）    |
| 任务队列        | BullMQ（Redis）             |
| RSS 解析      | rss-parser                |
| ActivityPub | BotKit（基于 Fedify）       |
| 前端          | Nuxt（SSR）+ Nuxt UI        |

## 模块划分

```
rssfed/
├── packages/hono-server/     # Hono API 服务（认证、RSS 聚合、ActivityPub 分发）
│   ├── src/
│   │   ├── app.ts          ← Hono app 定义（可测试导入）
│   │   ├── auth.ts         ← Better Auth 服务端配置
│   │   ├── config.ts       ← 环境变量解析（CORS origins 等）
│   │   ├── db/             ← Drizzle schema + 迁移
│   │   ├── bots/           ← ActivityPub Bot（BotKit）
│   │   ├── couchdb/        ← CouchDB 客户端（nano）
│   │   ├── routes/         ← feeds、sync、bots、subscriptions
│   │   ├── rss/            ← rss-parser 封装
│   │   └── workers/        ← BullMQ Worker（RSS 定时抓取）
│   │
│   └── src/index.ts        ← 入口，serve() 启动
│
└── packages/nuxt-client/        # Nuxt 前端（SSR）
    ├── app/
    │   ├── app.vue         ← 根组件（含顶部导航 + 登录态）
    │   ├── pages/          ← 路由页面
    │   ├── stores/         ← Pinia 全局状态
    │   ├── composables/    ← auto-imported composables（含 useAuth）
    │   └── middleware/     ← Nuxt 路由中间件
    └── server/middleware/  ← Nitro 中间件（/api/* 反向代理到 Hono）
```

## 同步架构分层

```
        服务端                       浏览器
┌─────────────────────┐   PouchDB   ┌────────────────────┐
│  feed:{feedId-1}    │───replicate──▶                      │
│  （订阅源条目库）      │             │                      │
│                     │             │                      │
│  feed:{feedId-2}    │───replicate──▶   PouchDB 本地库      │
│  （订阅源条目库）      │             │   （跨源条目合并）       │
│                     │             │                      │
│  feed:{feedId-3}    │───replicate──▶                      │
│  （订阅源条目库）      │             │                      │
│                     │             └──────┬───────────────┘
│                     │                    │ Mango 查询
│                     │                    ▼
│                     │          按时间线展示所有源条目
│                     │
│  user-state:{userId}│◀───双向同步──── PouchDB 本地库
│  （已读/收藏状态）     │             （用户操作状态）
└─────────────────────┘
```

### 关键设计原则

- **每个订阅源独立 CouchDB 库** — `feed:{feedId}` 存储该源的 FeedDoc + EntryDoc。浏览器 PouchDB 逐个同步用户订阅的 feed 库，在本地完成跨源合并
- **用户状态独立库存放** — `user-state:{userId}` 存放用户对条目的操作（已读、收藏），各设备双向同步此库来保持跨设备一致
- **无需服务端过滤复制** — 浏览器端按需拉取各个 feed 库，避免 CouchDB 过滤复制（`_replicate` + filter）在大数据量下的性能瓶颈
- **Bot 做逻辑分组，feed 独立库做物理存储** — 一个 Bot 跟踪多个 feed，一个 feed 可被多个 Bot 引用，但物理上每个 feed 只存一份数据，无冗余

### 用户状态库 `user-state:{userId}`

存储每个用户对条目的操作状态，数据量小且完全按用户隔离：

```
user-state:alice
  ├── entry-state:{entryId}  →  { read: true, readAt: "...", saved: false }
  ├── entry-state:{entryId}  →  { read: false, saved: true }
  └── ...
```

各端浏览器 PouchDB 双向同步此库，确保手机标记已读 → 电脑实时同步。

### Bot 分组的逻辑视图 vs 物理存储

```
        用户视角                           物理存储
┌─────────────────────┐         ┌──────────────────────┐
│  Bot "技术早报"      │         │  feed:A（独立 CouchDB 库）│
│  ├── feed:A         │────────▶│  feed:B（独立 CouchDB 库）│
│  ├── feed:B         │         │  feed:C（独立 CouchDB 库）│
│  └── feed:C         │         └──────────────────────┘
│                     │         ┌──────────────────────┐
│  Bot "AI 动态"      │         │  feed:A（同上，复用）    │
│  ├── feed:A         │────────▶│  feed:D（独立 CouchDB 库）│
│  ├── feed:D         │         │  feed:E（独立 CouchDB 库）│
│  └── feed:E         │         └──────────────────────┘
│                     │
│  （单独订阅）         │         ┌──────────────────────┐
│  └── feed:F         │────────▶│  feed:F（独立 CouchDB 库）│
└─────────────────────┘         └──────────────────────┘
```

Bot 与 feed 的关联关系存储在 PostgreSQL `bot_feeds` 表中。浏览器按 Bot 展开时：

1. 查 Bot → 获取 feedId 列表
2. 对每个 feedId 启动 PouchDB `_replicate`（已同步过的 feed 自动跳过）
3. 本地 PouchDB 跨源合并后，按时间线渲染

这样做的好处：
- **零数据冗余** — feed:A 无论被几个 Bot 引用，物理上只存一份
- **保留灵活性** — 用户仍可直接订阅单个 feed，不强制走 Bot
- **前端分组自然** — 按 Bot 切换视图，底层 feed 库按需同步

## 数据库职责划分

| 存储                      | 内容                          | 用途                     |
| ----------------------- | --------------------------- | ---------------------- |
| PostgreSQL（Drizzle）    | 用户、bots、bot_feeds 关联、bot_outbox（仅标题+摘要+原文URL，不含压缩图片）、订阅关系 | 核心业务、认证、关系管理、Bot 出站队列 |
| CouchDB feed:{feedId}   | 单个订阅源的 FeedDoc + EntryDoc              | RSS 内容权威来源，每源独立库            |
| CouchDB user-state:{id} | 用户对条目的 read/saved 状态                  | 多设备阅读状态同步                   |
| PouchDB（浏览器）           | 订阅源的条目 + 用户操作状态（本地合并）              | 离线阅读、跨源聚合查询                 |

## 部署架构

```
反向代理（Caddy / nginx）:443
  ├── /api/*              → Hono（后端服务）
  ├── /mcp、/mcp/*        → Hono（MCP 端点，不能做 301/307）
  ├── /.well-known/*      → Hono（webfinger）
  ├── /nodeinfo/*         → Hono
  ├── /users/*、/inbox    → Hono（ActivityPub actor / inbox）
  └── /*                  → Nuxt（SSR 渲染）
```

后端的 ActivityPub 端点由 Hono 的 `app.all("*")` 兜底提供，**只转发 `/api/*` 会让联邦功能整体 404**，而首页看起来完全正常。

前端不经过 Nitro 代理后端：浏览器按 `NUXT_PUBLIC_API_BASE_URL` 直连后端（见 `packages/nuxt-client/app/composables/useApi.ts`），同域部署下即反代地址，cookie 同站。生产部署步骤见 [docs/docker-deployment.md](docs/docker-deployment.md)，反代规则见 [deploy/Caddyfile](deploy/Caddyfile)。

## 数据流

1. **RSS 资讯聚合**：用户发现并订阅感兴趣的 feed → rss-parser 解析 → 写入对应 feed:{feedId} 库（去重）→ BullMQ 定时调度周期性拉取更新
2. **用户同步**：登录后 → 获取用户订阅的 feedId 列表 → 浏览器 PouchDB 逐个 `_replicate` feed 库到本地 → 本地 PouchDB 跨源合并，按时间线展示
3. **离线阅读**：浏览器 PouchDB 本地缓存 → 离线浏览、跨源搜索、按时间排序 → 标记已读/收藏 → 同步到 user-state 库 → 其他设备接收变更
4. **ActivityPub 分发**：Worker 抓取到新条目 → 查 PostgreSQL bot_feeds 找出引用该 feed 的 Bot → 对每个 Bot 通过 BotKit 构建 Create Activity 推送到 follower inbox → 同时写入 PostgreSQL bot_outbox 表供 outbox 查询（按 botId + publishedAt 索引，查询高效）

   > **为什么不把压缩图片也放进 bot_outbox？** 两个场景的消费者不同：PouchDB 同步 feed 库中的条目供离线阅读，需要下载并压缩图片嵌入文档；ActivityPub outbox 返回的是轻量分发元数据，远程实例会自行拉取原始图片 URL，不需要也不应该处理压缩版本。bot_outbox 只存标题、摘要、原文链接即可。
