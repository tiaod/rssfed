# RSSFed 架构设计

## 项目定位

RSSFed 是一个**离线优先的、基于用户兴趣的资讯聚合与推送工具**，旨在帮助用户在信息爆炸的时代高效地获取自己真正关心的内容。核心能力：

1. **RSS 协议资讯聚合** — 自实现抓取引擎，定时从用户订阅的 Feed 拉取内容（BullMQ 调度 + feedsmith）
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
| RSS 解析      | feedsmith                |
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
│   │   ├── rss/            ← feedsmith 封装
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
| PostgreSQL（Drizzle）    | 用户与认证（`user` / `session` / `account` / `api_token`）、`bots`、`bot_feeds` / `bot_followers` / `bot_following` 关联、`bot_inbox`、`feeds` 注册表、`site_settings`、Fedify KV | 核心业务、认证、关系与元数据 |
| CouchDB feed:{feedId}   | 单个订阅源的 FeedDoc + EntryDoc（正文图片作为附件随文档存放） | RSS 内容权威来源，每源独立库            |
| CouchDB user-state:{id} | 用户的**订阅关系**（`subscription` 文档）+ read/saved 状态 | 离线优先的订阅管理、多设备阅读状态同步 |
| CouchDB bot:{botId}     | Bot 的产出文档（ActivityPub outbox 的内容源） | Bot 分发与 outbox 查询 |
| PouchDB（浏览器）           | 订阅源的条目 + 用户操作状态（本地合并）              | 离线阅读、跨源聚合查询                 |

### 为什么订阅关系在 CouchDB 而不在 PostgreSQL

最初的设计是把订阅关系放进 PostgreSQL，但它**与离线优先目标冲突**：离线阅读要求用户断网时也能订阅/退订，这些改动先落在浏览器 PouchDB，联网后再与服务端合并。关系型表没有对应的客户端副本与冲突合并机制，跨端修改无法收敛。

因此订阅关系统一改由 CouchDB `user-state:{id}` 库承载（`subscription` 文档），与已读/收藏状态复用同一条 PouchDB 双向同步链路。**PostgreSQL 侧没有「某用户订阅了哪些 feed」的表**：`feeds` 只是所有已知订阅源的注册表（供 Worker 定时抓取），`bot_feeds` 是 Bot↔feed 的关联，两者都不表示用户订阅。

同理，**Bot 的产出也不在 PostgreSQL**：`workers/index.ts` 把每个 Bot 的产出写入其专属的 CouchDB `bot:{botId}` 库，outbox 路由从该库的 `entries-by-date` 视图读取（见 `routes/bots.ts`）。PostgreSQL 中不存在 `bot_outbox` 表。

**但 Bot 的身份数据仍在 PostgreSQL**，其中最要紧的是 **actor 密钥对**：Fedify 把它存在 `fedify_kv_v2` 里（键形如 `["_botkit", "bots", {username}, "keyPairs"]`），删除 Bot 时由 `clearBotKv()` 一并清理 —— 只删 `bots` 表行的话，同名重建的 Bot 会复用旧私钥。密钥对**不可重建**：丢失后 Bot 会生成新密钥，已关注实例缓存的公钥随之失效。

两处容易踩的约束：

- `bots.preferred_username` **必须有唯一约束** —— 它就是联邦标识符 `@username@域名`，ActivityPub 的 acct 语义要求全局唯一；创建接口对重名返回 409。
- **Fedify 的表必须放在独立 schema（`fedify`）下，不能留在 `public`**：`fedify_kv_v2` / `fedify_message_v2` 由 `@fedify/postgres` 自建自管、不在本仓库 schema 中，留在 `public` 的话 `drizzle-kit push` 会把它们当成「多余的副本」直接 DROP —— 而 migrate 跑的是 `push --force`（无人值守、自动批准数据丢失语句），等于每次部署都可能清掉 Bot 私钥。做法是让 BotKit 的独立连接把 `search_path` 指向 `fedify`（见 `bots/index.ts` 的 `botkitSql`），schema 由启动流程的 `ensureFedifySchema()` 幂等创建；drizzle 默认只管理 `public`，从此结构上就够不着。`drizzle.config.ts` 另配了 `tablesFilter: ["*", "!fedify_*"]` 作为第二道防线。

## 文件存储职责

二进制文件有**两条完全不同的路径**，改相关代码前先确认自己面对的是哪一类 —— 这一点容易误判（正文图片其实不走对象存储）：

| 文件类型 | 存放位置 | 访问方式 |
| --- | --- | --- |
| 正文图片（抓取时压缩为 AVIF） | **CouchDB 附件**，跟随条目文档 | 随 PouchDB 同步到浏览器，供离线阅读 |
| 头像、Bot 头像、站点 logo | **存储后端**（`Storage` 接口） | 经 `/api/files/*` 代理读取，或配置公开域名直连 |

### 为什么正文图片不放对象存储

正文图片要跟随 feed 库同步进浏览器 PouchDB 以供离线阅读，作为 CouchDB 附件写入时与条目文档天然同源同步，省掉了独立下载与关联的逻辑。代价是放宽了 CouchDB 的附件大小上限（默认 1MB → 8MB，见 `index.ts` 的 `couchdb/max_attachment_size`）。

### 头像为什么单独走存储后端

头像与 logo 是**上传类**文件（用户主动提交、需要独立 URL 展示），不适合塞进文档库。它们统一走 `Storage` 接口，有两个可切换的实现：

| `STORAGE_DRIVER` | 实现 | 说明 |
| --- | --- | --- |
| `fs` | `FilesystemStorage` | 写本地目录（生产挂持久卷），小规模部署够用 |
| `s3`（默认） | `S3Storage` | S3 兼容对象存储：SeaweedFS / 云 COS / R2 |

两个实现对 key 的语义一致；`getPublicUrl` 在未配置公开域名时都返回 `undefined`，由调用方回退到 `/api/files/*` 代理 —— 因此切换后端不需要改业务代码。部署细节见 [docs/docker-deployment.md](docs/docker-deployment.md) 第 9 节。

## 部署架构

```
反向代理（Caddy / nginx）:443
  ├── /api/*              → Hono（后端服务）
  ├── /mcp、/mcp/*        → Hono（MCP 端点，不能做 301/307）
  ├── /.well-known/*      → Hono（webfinger）
  ├── /nodeinfo/*         → Hono
  ├── /ap/*               → Hono（ActivityPub actor / inbox / outbox）
  ├── /@*                 → Hono（actor 的 profile 页）
  ├── /users/*、/inbox    → Hono（Fedify 默认路由，当前未启用）
  └── /*                  → Nuxt（SSR 渲染）
```

后端的 ActivityPub 端点由 Hono 的 `app.all("*")` 兜底提供，**只转发 `/api/*` 会让联邦功能整体 404**，而首页看起来完全正常。

前端不经过 Nitro 代理后端：浏览器按 `NUXT_PUBLIC_API_BASE_URL` 直连后端（见 `packages/nuxt-client/app/composables/useApi.ts`），同域部署下即反代地址，cookie 同站。生产部署步骤见 [docs/docker-deployment.md](docs/docker-deployment.md)，反代规则见 [deploy/Caddyfile](deploy/Caddyfile)。

## 数据流

1. **RSS 资讯聚合**：用户发现并订阅感兴趣的 feed → feedsmith 解析 → 写入对应 feed:{feedId} 库（去重）→ BullMQ 定时调度周期性拉取更新
2. **用户同步**：登录后 → 获取用户订阅的 feedId 列表 → 浏览器 PouchDB 逐个 `_replicate` feed 库到本地 → 本地 PouchDB 跨源合并，按时间线展示
3. **离线阅读**：浏览器 PouchDB 本地缓存 → 离线浏览、跨源搜索、按时间排序 → 标记已读/收藏 → 同步到 user-state 库 → 其他设备接收变更
4. **ActivityPub 分发**：Worker 抓取到新条目 → 查 PostgreSQL `bot_feeds` 找出引用该 feed 的 Bot → 对每个 Bot 通过 BotKit 构建 Create Activity 推送到 follower inbox → 同时写入该 Bot 的 **CouchDB `bot:{botId}` 产出库**供 outbox 查询（`entries-by-date` 视图按 publishedAt 排序，天然支持倒序分页）

   > **为什么 Bot 产出库里不放压缩图片？** 两个场景的消费者不同：PouchDB 同步 feed 库中的条目供离线阅读，需要下载并压缩图片嵌入文档；ActivityPub outbox 返回的是轻量分发元数据，远程实例会自行拉取原始图片 URL，不需要也不应该处理压缩版本。Bot 产出库只存标题、摘要、原文链接即可。

## 离线可用（Service Worker）

「离线优先」在数据上由 PouchDB 保证，但**页面本身也得打得开**——否则断网后连壳都没有。这一层由 `packages/nuxt-client/public/sw.js` 承担，配置见 `nuxt.config.ts`（`nitro.prerender` 与 `nitro:build:public-assets` 钩子），注册见 `app/plugins/service-worker.client.ts`。

三层策略：

| 请求类型 | 策略 | 说明 |
| --- | --- | --- |
| 构建产物 `/_nuxt/**`、静态文件 | 缓存优先 | 文件名带内容哈希，内容永不变化；构建期由钩子扫描 `.output/public` 生成 `/sw-manifest.json`，SW 安装时整份预缓存 |
| 页面导航 | 网络优先 → 同路径 HTML 缓存 → `/offline` 外壳 | 访问过的页面离线可原样打开；没访问过的路径回退到预渲染的离线外壳，客户端接管后按地址栏 URL 渲染真实路由 |
| 只读接口（条目、站点配置、文件、会话） | 网络优先 + 落缓存 | 断网时读缓存；写操作不拦截，让调用方拿到真实失败 |
| 其它（PouchDB 复制 `/api/couchdb/proxy/*` 等） | 不拦截 | 同步语义必须由 PouchDB 自己处理重试与 checkpoint |

几个关键决策：

- **缓存名带构建号**：构建钩子把 `sw.js` 里的 `__BUILD_ID__` 替换成时间戳，新 SW 用新缓存名，`activate` 时整体删除旧缓存——避免旧 HTML 去引用已被删除的旧 chunk。
- **不自动 `skipWaiting`**：首次安装直接接管；更新时先待命，由页面提示「有新版本可用」，用户点刷新才激活。否则新版一上来就清缓存，正在使用旧版页面的标签页会白屏。
- **开发环境不注册**：缓存优先会挡住 Vite 的 HMR 请求，`app/plugins/service-worker.client.ts` 里用 `import.meta.dev` 短路。
- **路由中间件在离线时放行**：拿不到会话不该把用户赶去登录页（`app/middleware/auth.ts`）。
