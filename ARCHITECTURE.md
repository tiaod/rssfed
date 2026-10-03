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
│   ├── src/{auth,config}.ts      # Better Auth 配置 · 环境变量解析
│   ├── src/db/                   # Drizzle schema + 迁移
│   ├── src/bots/ · couchdb/      # BotKit Bot · CouchDB 客户端（nano）+ 代理认证
│   ├── src/routes/               # feeds / couchdb / bots / user / user-tokens / site-settings / mcp
│   ├── src/rss/ · pwa/           # feedsmith 封装 · manifest 与图标渲染
│   ├── src/storage.ts            # Storage 接口（fs / s3）
│   └── src/workers/              # BullMQ Worker（RSS 定时抓取）
└── packages/nuxt-client/         # Nuxt 前端（SSR）
    ├── app/                      # app.vue · pages/ · components/（EntryList 等）
    │                             # composables/ · stores/ · middleware/ · utils/
    ├── public/sw.js              # Service Worker（见 offline-and-pwa.md）
    └── nuxt.config.ts            # 开发期 routeRules 代理；生产由反代分流
```

## 同步架构分层

```
        服务端                                    浏览器
  feed:{feedId-1}  ──replicate──▶  ┐
  feed:{feedId-2}  ──replicate──▶  ├─▶ PouchDB 本地库 ──Mango 查询──▶ 按时间线展示
  feed:{feedId-3}  ──replicate──▶  ┘   （跨源条目合并）

  user-state:{userId} ◀──双向同步──▶ PouchDB 本地库（用户操作状态）
```

### 关键设计原则

- **每个订阅源独立 CouchDB 库** — `feed:{feedId}` 存储该源的 FeedDoc + EntryDoc。浏览器 PouchDB 逐个同步用户订阅的 feed 库，在本地完成跨源合并
- **用户状态独立库存放** — `user-state:{userId}` 存放用户对条目的操作（已读、收藏），各设备双向同步此库来保持跨设备一致
- **按窗口过滤复制，锚点固定** — 首轮同步只拉最近 N 天（默认 3 天，设置页可改）的条目：服务端 `_selector`
  过滤（`publishedAt >= 锚点` 或 FeedDoc），窗口外历史不进浏览器。锚点按「源 + 档位」存下后不跟随时钟走：
  PouchDB 复制 id 由 selector 参与计算，锚点一变就重开 checkpoint，等于所有源的 `_changes` 从头重扫
  （实测 642 源 ≈ 23MB）。窗口只决定往回补多长历史，之后都是增量；调小窗口不删本地已有条目
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

浏览器按 Bot 展开时：查 Bot 拿到 feedId 列表 → 对每个 feedId 启动 PouchDB `_replicate`（已同步过的
自动跳过）→ 本地跨源合并后按时间线渲染。好处是零冗余（feed:A 被几个 Bot 引用都只存一份）、用户仍可
直接订阅单个 feed，且前端按 Bot 切换视图时底层 feed 库按需同步。

## 数据库职责划分

| 存储                      | 内容                          | 用途                     |
| ----------------------- | --------------------------- | ---------------------- |
| PostgreSQL（Drizzle）    | 用户与认证（`user` / `session` / `account` / `api_token`）、`bots`、`bot_feeds` / `bot_followers` / `bot_following` 关联、`bot_inbox`、`feeds` 注册表、`site_settings`、Fedify KV | 核心业务、认证、关系与元数据 |
| CouchDB feed:{feedId}   | 单个订阅源的 FeedDoc + EntryDoc（正文图片作为附件随文档存放） | RSS 内容权威来源，每源独立库            |
| CouchDB user-state:{id} | 用户的**订阅关系**（`subscription` 文档）+ read/saved 状态 | 离线优先的订阅管理、多设备阅读状态同步 |
| CouchDB bot:{botId}     | Bot 的产出文档（ActivityPub outbox 的内容源） | Bot 分发与 outbox 查询 |
| PouchDB（浏览器）           | 订阅源的条目 + 用户操作状态（本地合并）              | 离线阅读、跨源聚合查询                 |

### 为什么订阅关系在 CouchDB 而不在 PostgreSQL

最初的设计是把订阅关系放进 PostgreSQL，但它**与离线优先目标冲突**：离线阅读要求用户断网时也能
订阅/退订，这些改动先落在浏览器 PouchDB，联网后再与服务端合并。关系型表没有对应的客户端副本与
冲突合并机制，跨端修改无法收敛。因此订阅关系统一改由 CouchDB `user-state:{id}` 库承载
（`subscription` 文档），与已读/收藏状态复用同一条 PouchDB 双向同步链路。**PostgreSQL 侧没有
「某用户订阅了哪些 feed」的表**：`feeds` 只是所有已知订阅源的注册表（供 Worker 定时抓取），
`bot_feeds` 是 Bot↔feed 的关联，两者都不表示用户订阅。

同理 **Bot 的产出也不在 PostgreSQL**：`workers/index.ts` 把每个 Bot 的产出写入其专属的 CouchDB
`bot:{botId}` 库，outbox 路由从该库的 `entries-by-date` 视图读取（见 `routes/bots.ts`）——
PostgreSQL 中不存在 `bot_outbox` 表。

**但 Bot 的身份数据仍在 PostgreSQL**，最要紧的是 **actor 密钥对**：Fedify 把它存在 `fedify_kv_v2`
里（键形如 `["_botkit", "bots", {username}, "keyPairs"]`），删除 Bot 时由 `clearBotKv()` 一并清理
—— 只删 `bots` 表行的话，同名重建的 Bot 会复用旧私钥，而已分发给关注者的公钥无法撤回。

两条容易踩的约束：

- `bots.preferred_username` **必须有唯一约束** —— 它就是联邦标识符 `@username@域名`，ActivityPub
  的 acct 语义要求全局唯一；创建接口对重名返回 409。
- **Fedify 的表必须放在独立 schema（`fedify`）下，不能留在 `public`**：`fedify_kv_v2` /
  `fedify_message_v2` 由 `@fedify/postgres` 自建自管、不在本仓库 schema 中，留在 `public` 的话
  `drizzle-kit push` 会把它们当成「多余的副本」直接 DROP —— 而 migrate 跑的是 `push --force`
  （无人值守、自动批准数据丢失语句），等于每次部署都可能清掉 Bot 私钥。做法是让 BotKit 的独立连接
  把 `search_path` 指向 `fedify`（见 `bots/index.ts` 的 `botkitSql`），schema 由启动流程的
  `ensureFedifySchema()` 幂等创建；`drizzle.config.ts` 另配了 `tablesFilter: ["*", "!fedify_*"]`
  作为第二道防线。

## 文件存储职责

二进制文件有**两条完全不同的路径**，改相关代码前先确认自己面对的是哪一类 —— 这一点容易误判
（正文图片其实不走对象存储）：

| 文件类型 | 存放位置 | 访问方式 |
| --- | --- | --- |
| 正文图片（抓取时压缩为 AVIF） | **CouchDB 附件**，跟随条目文档 | 随 PouchDB 同步到浏览器，供离线阅读 |
| 头像、Bot 头像、站点 logo | **存储后端**（`Storage` 接口） | 经 `/api/files/*` 代理读取，或配置公开域名直连 |

**为什么正文图片不放对象存储**：正文图片要跟随 feed 库同步进浏览器 PouchDB 以供离线阅读，作为
CouchDB 附件写入时与条目文档天然同源同步，省掉了独立下载与关联的逻辑。代价是放宽了 CouchDB 的
附件大小上限（默认 1MB → 8MB，见 `index.ts` 的 `couchdb/max_attachment_size`）。

**正文图片缓存：主约束是「每篇附件总体积预算」**，默认 1MB（per-feed 可覆盖
`max_entry_image_bytes`）：压缩后按正文顺序累计，超预算即停止缓存后续图片，首图必留。用体积而不是
张数，是因为小图（实测 p50 约 19KB）能存几十张、大图自然少存，更贴近真实成本；`max_image_count`
（默认 200）因此退化为**请求数硬顶**。抓取失败不阻塞、回退为无图条目。诊断入口：
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
2. **用户同步**：登录后 → 获取用户订阅的 feedId 列表 → 浏览器 PouchDB 逐个 `_replicate` feed 库到本地（只拉同步窗口内的条目）→ 本地 PouchDB 跨源合并，按时间线展示。进入单个列表时该列表的源插到复制队列最前：本地有缓存就先上屏、同步在后台跑（新条目折叠进「已同步 N 条」），本地空的才等它（最多 5s）再上屏
3. **离线阅读**：浏览器 PouchDB 本地缓存 → 离线浏览、跨源搜索、按时间排序 → 打开条目即标已读/手动切换已读与收藏 → 同步到 user-state 库 → 其他设备接收变更
4. **ActivityPub 分发**：Worker 抓取到新条目 → 查 PostgreSQL `bot_feeds` 找出引用该 feed 的 Bot → 对每个 Bot 通过 BotKit 构建 Create Activity 推送到 follower inbox → 同时写入该 Bot 的 **CouchDB `bot:{botId}` 产出库**供 outbox 查询（`entries-by-date` 视图按 publishedAt 排序，天然支持倒序分页）

   > **为什么 Bot 产出库里不放压缩图片？** 两个场景的消费者不同：PouchDB 同步 feed 库中的条目供离线阅读，需要下载并压缩图片嵌入文档；ActivityPub outbox 返回的是轻量分发元数据，远程实例会自行拉取原始图片 URL，不需要也不应该处理压缩版本。Bot 产出库只存标题、摘要、原文链接即可。
