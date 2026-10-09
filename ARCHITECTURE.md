# RSSFed 架构设计

> 本文只记录**不变量与取舍**：什么必须成立、为什么这样选。实现细节与操作步骤不放这里。
> 细节分册：[前端列表渲染](docs/frontend-list-rendering.md) · [Service Worker 与 PWA](docs/offline-and-pwa.md) ·
> [部署步骤](docs/docker-deployment.md) · [排障（现象 → 原因 → 解法）](docs/troubleshooting.md) · [未落地事项](docs/cloud-deployment-todo.md)

## 项目定位

RSSFed 是一个**离线优先的、基于用户兴趣的资讯聚合与推送工具**。核心能力：

1. **RSS 资讯聚合** — 自实现抓取引擎，定时从用户订阅的 Feed 拉取内容（BullMQ 调度 + feedsmith）
2. **离线优先的订阅管理与阅读** — 服务端 CouchDB（每个订阅源独立库）+ 客户端 PouchDB 同步，支持离线缓存、已读/收藏标记，联网后自动合并
3. **ActivityPub 内容分发** — 通过 BotKit（基于 Fedify）将聚合的资讯以 ActivityPub 机器人身份推送到 Fediverse

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
rssfed/                          # pnpm workspace
├── packages/hono-server/        # Hono API：认证、RSS 聚合、ActivityPub 分发
│   ├── src/app.ts · index.ts     # app 定义（可测试导入）· 入口 serve()
│   ├── src/config.ts             # 环境变量解析
│   ├── src/db/ · src/auth.ts     # Drizzle schema + 迁移 · Better Auth 配置
│   ├── src/bots/ · couchdb/      # BotKit Bot · CouchDB 客户端（nano）+ 代理认证
│   ├── src/routes/               # feeds / couchdb / timeline / bots / user / site-settings / mcp
│   ├── src/rss/ · images/ · pwa/ # feedsmith 封装 · 图片压缩与内容寻址缓存 · manifest/图标
│   ├── src/storage.ts            # Storage 接口（fs / s3）
│   └── src/workers/ · services/  # BullMQ（抓取 + 时间线聚合）· 聚合服务
└── packages/nuxt-client/         # Nuxt 前端（SSR）
    ├── app/                      # app.vue · pages/ · components/ · composables/ · stores/ · utils/
    ├── public/sw.js              # Service Worker（见 offline-and-pwa.md）
    └── nuxt.config.ts            # 开发期 routeRules 代理；生产由反代分流
```

## 同步架构分层

```
            服务端（聚合）                                    浏览器
  feed:{feedId-1}  ┐
  feed:{feedId-2}  ├─聚合─▶ user-timeline_{userId} ──live 单向复制──▶ PouchDB 本地库
  feed:{feedId-3}  ┘   （按该用户的窗口 / 图片参数裁剪）        （整条时间线 = 一个库）
  user-state:{userId} ◀──live 双向同步──▶ PouchDB 本地库（订阅 + 已读/收藏）
```

### 关键设计原则

- **聚合在服务端完成，浏览器只拉一个库** — Worker 把用户订阅的每个 feed 的条目增量搬进用户专属的派生库
  （库名随机、存在 `user.timeline_db_name` 列，`_security.members.names = [userId]`；条目是**独立副本**，
  正文图片按该用户参数重新压缩后作附件）。浏览器只做一条 live 单向复制，订阅 3 个源和 300 个源开销一样
- **每用户一份冗余是明确取舍** — 用户量小，用磁盘换掉「客户端逐源合并 + 逐源调参」的全部复杂度；派生库随时可删可重建（`rebuildUserTimeline`），`feed:{feedId}` 仍是权威来源
- **窗口与附件策略按用户生效** — 窗口默认 3 天（可改 1/3/7/30/不限），在服务端生效：**调小会删除派生库里
  窗口外的条目**（客户端跟随删除），调大走回填。图片张数/体积预算/宽度/AVIF 质量/源图上限同样 per-user
  （`user_timeline_settings`），改图片参数触发重建
- **Bot 做逻辑分组，feed 独立库做物理存储** — 一个 Bot 跟踪多个 feed，一个 feed 可被多个 Bot 引用，但物理上每个 feed 只存一份数据，无冗余

### 用户状态库 `user-state:{userId}`

存储每个用户对条目的操作状态，数据量小且完全按用户隔离：

```
user-state:alice
  ├── entry-state:{entryId}  →  { read: true, readAt: "...", saved: false }
  └── ...
```

**一条不变量：已读与收藏共用同一条文档**（`entry-state:{entryId}`），所以写入一律走 `usePouchDb`
的读改写：读最新一版 → 只合并要改的字段 → 写回，409 冲突则重读重算（最多 3 轮）。禁止「get 失败
就当文档不存在、直接新建」：get 也可能因网络等原因失败，那样新建会冲掉对端刚写入的收藏位。
具体交互见 [frontend-list-rendering.md](docs/frontend-list-rendering.md#已读--收藏)。

### Bot 分组的逻辑视图 vs 物理存储

Bot 与 feed 是多对多，关联关系存储在 PostgreSQL `bot_feeds` 表中；物理上每个 feed 只有一个独立 CouchDB 库：

```
用户视角                              物理存储
Bot "技术早报" → feed:A、B、C   ┐
Bot "AI 动态"  → feed:A、D、E   ├──▶  每个 feed 一个独立库
单独订阅       → feed:F         ┘     （feed:A 只有一份）
```

浏览器按 Bot 展开时：拿 feedId 列表 → 直接查本地派生库（Bot 的 feed 属于该用户的订阅，条目已在
`user-timeline` 里）。零冗余（feed:A 被几个 Bot 引用都只存一份），且浏览器不再需要知道 feed 库的存在。

## 数据库职责划分

| 存储                      | 内容                          | 用途                     |
| ----------------------- | --------------------------- | ---------------------- |
| PostgreSQL（Drizzle）    | 用户与认证（`user` / `session` / `account` / `api_token`）、`bots`、`bot_*` 关联、`bot_inbox`、`feeds` 注册表、`site_settings`、`user_timeline_settings`、Fedify KV | 核心业务、认证、关系与元数据 |
| CouchDB feed:{feedId}   | 单个订阅源的 FeedDoc + EntryDoc（正文图片作为附件随文档存放） | RSS 内容权威来源，每源独立库            |
| CouchDB user-state:{id} | 用户的**订阅关系**（`subscription` 文档）+ read/saved 状态 | 离线优先的订阅管理、多设备阅读状态同步 |
| CouchDB user-timeline:{id} | 该用户订阅范围的条目**副本**（按窗口/图片参数裁剪）+ FeedDoc 副本 | 服务端聚合结果，客户端只同步这一个库 |
| CouchDB bot:{botId}     | Bot 的产出文档（ActivityPub outbox 的内容源） | Bot 分发与 outbox 查询 |
| PouchDB（浏览器）           | `user-timeline` 的本地副本 + 用户操作状态              | 离线阅读、跨源聚合查询                 |
| 存储后端 `image-cache/` 前缀 | 正文图压缩结果（key = URL + 参数的内容寻址） | 同一张图只为不同参数各压一次 |

### 为什么订阅关系在 CouchDB 而不在 PostgreSQL

最初的设计是把订阅关系放进 PostgreSQL，但它**与离线优先目标冲突**：离线阅读要求用户断网时也能
订阅/退订，这些改动先落在浏览器 PouchDB，联网后再与服务端合并。关系型表没有对应的客户端副本与
冲突合并机制，跨端修改无法收敛。因此订阅关系统一改由 CouchDB `user-state:{id}` 库承载
（`subscription` 文档），与已读/收藏状态复用同一条 PouchDB 双向同步链路。**PostgreSQL 侧没有
「某用户订阅了哪些 feed」的表**：`feeds` 只是所有已知订阅源的注册表（供 Worker 定时抓取），
`bot_feeds` 是 Bot↔feed 的关联，两者都不表示用户订阅。

同理 **Bot 的产出也不在 PostgreSQL**：`workers/index.ts` 把产出写入专属的 CouchDB `bot:{botId}` 库，
outbox 路由从该库的 `entries-by-date` 视图读取（见 `routes/bots.ts`），PG 中没有 `bot_outbox` 表。

**但 Bot 的身份数据仍在 PostgreSQL**，最要紧的是 **actor 密钥对**（Fedify 存在 `fedify_kv_v2`，键形如
`["_botkit", "bots", {username}, "keyPairs"]`）：删除 Bot 时由 `clearBotKv()` 一并清理 —— 只删 `bots`
表行的话，同名重建会复用旧私钥，而已分发给关注者的公钥无法撤回。

两条容易踩的约束：

- `bots.preferred_username` **必须有唯一约束** —— 它就是联邦标识符 `@username@域名`，ActivityPub
  的 acct 语义要求全局唯一；创建接口对重名返回 409。
- **Fedify 的表必须放在独立 schema（`fedify`）下，不能留在 `public`**：`fedify_kv_v2` / `fedify_message_v2`
  由 `@fedify/postgres` 自建自管、不在本仓库 schema 中，留在 `public` 会被 `drizzle-kit push` 当成「多余
  副本」DROP —— migrate 跑的 `push --force` 自动批准数据丢失语句，等于每次部署都可能清掉 Bot 私钥。做法是
  BotKit 的独立连接把 `search_path` 指向 `fedify`（见 `bots/index.ts`），schema 由 `ensureFedifySchema()`
  幂等创建；`drizzle.config.ts` 另配 `tablesFilter: ["*", "!fedify_*"]` 作第二道防线。

## 文件存储职责

二进制文件有**两条完全不同的路径**，动手前先确认面对哪一类（正文图片不走对象存储）：

| 文件类型 | 存放位置 | 访问方式 |
| --- | --- | --- |
| 正文图片（抓取/聚合时压缩为 AVIF） | **CouchDB 附件**，跟随条目文档 | 随派生库同步到浏览器，供离线阅读 |
| 头像、Bot 头像、站点 logo | **存储后端**（`Storage` 接口） | 经 `/api/files/*` 代理读取，或配置公开域名直连 |

**为什么正文图片不放对象存储**：它要跟随条目文档同步进浏览器供离线阅读，作为 CouchDB 附件写入即与文档
同源同步，省掉独立下载与关联逻辑。代价是放宽 CouchDB 附件大小上限（默认 1MB → 8MB，见 `index.ts`）。

**正文图片缓存：主约束是「每篇附件总体积预算」**，默认 1MB（feed 库看 per-feed 覆盖，派生库看 per-user
设置）：压缩后按正文顺序累计，超预算即停止缓存后续图片，首图必留。用体积而非张数，是因为小图（p50 约
19KB）能存几十张而大图自然少存，更贴近真实成本；`max_image_count`（默认 200）退化为**请求数硬顶**。
抓取失败不阻塞、回退为无图条目。

**压缩结果跨用户共享**（`images/cache.ts`）：同一张源图 + 同一组参数只下载、编码一次，产物按
`sha256(url + 宽度 + 质量)` 内容寻址存盘；per-user 参数差异只会让同一张图多压几版，不会重复下载。
浏览器不直连外站图片：附件随派生库同步到本地（`/api/images/cached` 只服务拿不到附件的场景）。诊断入口：
`scripts/diagnose-image-cache.ts`（只读扫描 `feed_*` 库，`--simulate` 走预算模拟，用法见脚本头部注释），
以及 worker 在有失败时打的一行 `[EntryImages] feed=… 候选=… 失败=… 原因[…]`。

**头像为什么单独走存储后端**：头像是**上传类**文件（用户主动提交、需要独立 URL 展示），不适合塞进
文档库。统一走 `Storage` 接口，有两个可切换的实现：

| `STORAGE_DRIVER` | 实现 | 说明 |
| --- | --- | --- |
| `fs` | `FilesystemStorage` | 写本地目录（生产挂持久卷），小规模部署够用 |
| `s3`（默认） | `S3Storage` | S3 兼容对象存储：SeaweedFS / 云 COS / R2 |

两个实现对 key 的语义一致；`getPublicUrl` 在未配置公开域名时都返回 `undefined`，由调用方回退到
`/api/files/*` 代理 —— 因此切换后端不需要改业务代码。部署细节见 [docs/docker-deployment.md](docs/docker-deployment.md) 第 9 节。

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

后端的 ActivityPub 端点由 Hono 的 `app.all("*")` 兜底提供，**只转发 `/api/*` 会让联邦功能整体 404**，
而首页看起来完全正常。

前端不经过 Nitro 代理后端：浏览器按 `NUXT_PUBLIC_API_BASE_URL` 直连后端（见 `useApi.ts`），
同域部署下即反代地址，cookie 同站。部署步骤见 [docs/docker-deployment.md](docs/docker-deployment.md)，
反代规则见 [deploy/Caddyfile](deploy/Caddyfile)。

## 数据流

1. **RSS 资讯聚合**：用户发现并订阅感兴趣的 feed → feedsmith 解析 → 写入对应 feed:{feedId} 库（去重）→ BullMQ 定时调度周期性拉取更新
2. **服务端聚合**：抓新条目 → 通知聚合队列（节流 30s，另有定时兜底与客户端催促）；一次聚合 = 退订清理 → 窗口剪枝 → 逐源增量/回填（每源完成即落盘游标）→ 更新状态文档。新写入由客户端那条 live 复制自动推下去
3. **用户同步**：登录后取 `timeline` / `userState` 两个库名 → 挂 live 复制（一条单向拉条目、一条双向同步状态）→ 首屏查本地库上屏；之后到达的条目折叠进「已同步 N 条」，用户点「查看」才换列表
4. **离线阅读**：浏览器 PouchDB 本地缓存 → 离线浏览、跨源搜索、按时间排序 → 打开条目即标已读/手动切换已读与收藏 → 同步到 user-state 库 → 其他设备接收变更
5. **ActivityPub 分发**：Worker 抓取到新条目 → 查 PostgreSQL `bot_feeds` 找出引用该 feed 的 Bot → 对每个 Bot 通过 BotKit 构建 Create Activity 推送到 follower inbox → 同时写入该 Bot 的 **CouchDB `bot:{botId}` 产出库**供 outbox 查询（`entries-by-date` 视图按 publishedAt 排序，天然支持倒序分页）

   > **为什么 Bot 产出库里不放压缩图片？** 两个场景的消费者不同：派生库同步给浏览器供离线阅读，需要压缩图片作为附件；ActivityPub outbox 返回的是轻量分发元数据，远程实例自行拉取原始图片 URL。Bot 产出库只存标题、摘要、原文链接。
