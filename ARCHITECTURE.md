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
│   └── src/                     # app/index · routes · services · workers（BullMQ）· db（Drizzle）· couchdb
│                                #   （nano + 代理认证）· rss · images · bots（BotKit）· storage
└── packages/nuxt-client/        # Nuxt 前端（SSR）
    └── app/                     # app.vue · pages · components · composables · stores · utils
```

## 同步架构分层

```
        服务端（每个 owner 各抓各的，直接写）                 浏览器
  feed URL ─抓取─▶ user:{userId} ──live 拉取（全量）──▶ PouchDB 本地库
                     / bot:{botId}  ──live 回写（只推状态）◀─ （条目+订阅+已读收藏同库）
  （两个 owner 订阅同一个源 = 两次抓取，但只有一次网络请求：见下「抓取缓存」）
```

### 关键设计原则

- **一个用户一个库，抓取直接写进去** — 用户专属库（库名随机，登记在 `user.timeline_db_name`；
  `_security.members.names = [userId]`）既是**订阅关系的权威**（`subscription:` 文档），
  也是这个用户抓到的全部内容。浏览器只对它挂两条 live 通道（拉取全量、回写状态）——
  订阅 3 个源和 300 个源开销一样
- **用户库不共享，哪怕只共享"条目"部分** — 曾经考虑过让多个用户关注同一个汇聚库（首页推荐榜单），
  已否决：用户库里除了条目还有**阅读记录与收藏**，将来还要按用户做个性化推荐，共享既会泄露阅读
  行为，也会让个性化互相污染。所以"一个用户一个库"是**隐私边界**，不只是实现细节；
  推荐/榜单若要做，做成只读的展示与"一键导入订阅"，不引入共享的同步目标
- **没有共享源库，抓取按 owner 各来一遍** — 旧模型是「写进共享的 `feed_*` 库 → 按需复制进各用户库」，
  好处是同源只抓一次、附件字节全局一致；代价是 707 个库 + 一整套扇出机器（CouchDB 复制器、
  PostgreSQL 水位、脏源判定、两侧各裁一遍、孤儿源清扫）。实测那套机器服务的共享倍率只有
  **1.03×**（707 源 / 133 订阅关系），所以现在的取舍是：**用 N 倍的写放大换掉整个扇出层**。
  重复的**网络请求**由抓取缓存摊平（见下条），写库与图片压缩是每个 owner 各一份
- **抓取缓存按 URL，是唯一的跨 owner 共享** — `rss/fetch-cache.ts` 按 URL 缓存 feed 正文与
  条件请求验证器（ETag/Last-Modified），默认 TTL 10 分钟（小于 15 分钟的基础抓取间隔，保证
  一个 tick 内同源只出一次网），另有**进程内单飞**把同一 URL 的并发抓取合并成一次。
  缓存是可丢弃的中间产物（删掉最多下次重下），不承担任何一致性
- **订阅文档必须带 `url`** — `feedId` 是 `sha256(url)` 的截断，不可逆，而调度读到订阅文档后
  必须能直接拿到抓取地址。`url` 因此属于**客户端可写输入**（PouchDB 双向同步），
  所以**每次抓取前都重新过 SSRF 闸门**（`rss/parser.ts` 的 `assertFetchableUrl`，含重定向逐跳
  校验），不能因为"写入时校验过"就跳过。`feedId` 与 `url` 不匹配的订阅文档判脏并跳过
- **调度状态与每源保留条数在用户库的 `_local/schedule`** — `_local` 文档不参与复制，浏览器看不到
  「服务端啥时候抓过这个源」这种纯内部状态，也随库一起删除。里面只有两样东西：每个源的
  `lastFetchedAt` / `errorStreak` / `hasValidators`，以及自适应算出的 `retentionEntries`。
  **不再有** PostgreSQL 的订阅关系投影表 —— 那张表要么从客户端可写文档同步（会漂移），
  要么就是另一份要维护的真相
- **保留策略只有一处实现，按 (owner × 源) 各自算** — 每源裁到最新 N 条，用 `_purge` 而非 delete
  （N 由该**用户库里这个源**的活跃度自适应：按近 14 天新增量分 10/20/30/50 四档，每天重算、
  一次最多变一档、阈值带 20% 滞回，见 `services/feed-retention-policy.ts`）。
  触发时机是「抓完这个源顺手裁」（`couchdb/retention.ts` 的 `trimOwnerFeedToLatestN`），
  成本 O(N) 而不是扫全库；缩小 N 时维护任务会立刻补裁一次
- **写方向由数据库层兜底，不靠客户端自觉** — 用户库设计文档（`_design/main`）里的
  `validate_doc_update` 只放行 `_admin`（代理转发时是 `roles:[user]` 身份，见 `routes/couchdb.ts`），
  客户端影子化/删除抓取产物在数据库层就会被拒，且关不掉这条规则
- **用户库就是唯一真相**（重构后不再有共享源库）— 删库 = 丢掉这个用户的阅读记录与已抓内容，
  重新抓 RSS 只能拿到发布方**当前还列着**的条目。旧模型「用户库随时可由源库重算」这条性质
  不再成立，以 50 条保留期看影响很小，但它是刻意的取舍
- **长期不活跃账号停止抓取** — 休眠只省 egress 与写库，**不需要任何重建**：回来时下一轮调度
  照常抓他订阅的源，缺的内容随那次抓取补上（旧模型"回来先换库重搬"那套随之删除）
- **Bot 是独立的 owner，各自抓一份** — `bot_feeds` 自带 `url` 与 `title`：Bot 的产出不能依赖
  「恰好有个用户订阅了它」（Bot 的联邦订阅者可能谁都没订阅那个源）。同一个源既被用户订阅、
  又被他的 Bot 引用时会抓两次，网络层由抓取缓存摊平，写库与图片压缩是两份
- **用户订阅 Bot 是唯一还需要"送内容过去"的路径** — 抓取按 owner 各写各的库，用户库与 Bot 库之间
  没有复制；但用户可以订阅一个 Bot（`subscription:bot:{botId}`，`kind: 'bot'`）。所以 Bot 一旦有新产出，
  抓取 job 会把它的条目搬给订阅者（`services/bot-subscription-sync.ts`），条目 `_id` 原样写进用户库
  （`entry:bot:{botId}:{hash}`），已存在就跳过。**这不是扇出的复辟**：Bot 产出是一个 Bot 一天几条，
  与「几百个源 × 每源几十条」不是一个量级

### 用户库 `user:{userId}`：三类文档，两个写入口

服务端写抓取产物与调度状态、客户端写自己的状态，同居一库（写方向见上）：

```
user:alice                                    写入口
  ├── feed:{feedId} / entry:{feedId}:{...}  →  源元信息与条目（含 AVIF 附件）    服务端
  ├── _local/schedule                       →  抓取调度状态 + 每源保留条数        服务端（不复制）
  ├── subscription:{feedId}                 →  { url, title, category, paused }  客户端（离线也能改）
  ├── entry-state:{entryId}                 →  { read, readAt, saved }           客户端
  └── group-pref:{name}                     →  列表分组偏好                       客户端
```

**`subscription:` 是唯一同时被两侧依赖的文档**：客户端写它（离线订阅/改名/分组），
服务端读它（调度要知道抓什么）。所以服务端对它的写入（暂停/恢复）必须走读改写 + 409 重试，
与服务端"独占写"的 `entry:` / `feed:` 严格分开 —— 后者由 `validate_doc_update` 在数据库层挡掉客户端。

**一条不变量：已读与收藏共用同一条文档**（`entry-state:{entryId}`），写入一律走 `usePouchDb` 的读改写（读最新
一版 → 只合并要改的字段 → 写回，409 则重读重算）；禁止「get 失败就当文档不存在、直接新建」—— get 也可能因
网络失败，那样新建会冲掉对端刚写入的收藏位。交互见 [frontend-list-rendering.md](docs/frontend-list-rendering.md#已读--收藏)。

### Bot 的产出是独立的一份

Bot 与源是多对多，关联关系存 PostgreSQL `bot_feeds`（**自带 `url` 与 `title`**）。每个 Bot 有自己的
CouchDB 产出库，由它自己抓取写入：

```
用户视角                              物理存储
Bot "技术早报" → 源 A、B、C   ┐
Bot "AI 动态"  → 源 A、D、E   ├──▶  每个 Bot 一个产出库（内容各存一份）
单独订阅       → 源 F         ┘     + 用户自己的库（如果该用户也订阅了 A）
```

同一个源被一个用户订阅、又被他的 Bot 引用时**会抓两次**（网络层由抓取缓存摊平）。
浏览器按 Bot 展开时：拿 feedId 列表 → 直接查本地库（这条 Bot 的订阅在用户库里，条目已同步下来）——
浏览器不需要知道 Bot 库的存在。

## 数据库职责划分

| 存储                      | 内容                          | 用途                     |
| ----------------------- | --------------------------- | ---------------------- |
| PostgreSQL（Drizzle）    | 用户与认证、`bots`/`bot_feeds`（含源 url）、`bot_inbox`、`site_settings`、`user_timeline_settings`、Fedify KV | 核心业务、认证、关系与元数据。**没有订阅关系表**（见下） |
| CouchDB user:{id}       | 订阅文档（含 url）+ 该用户抓到的条目（正文图作为附件）+ FeedDoc + read/saved 状态 + `_local/schedule` | **订阅关系与内容的唯一真相**，客户端只同步这一个库 |
| CouchDB bot:{botId}     | Bot 自己抓到的产出文档（ActivityPub outbox 的内容源） | Bot 分发与 outbox 查询 |
| PouchDB（浏览器）           | 上述用户库的本地副本（条目 + 订阅 + 已读收藏）           | 离线阅读、离线订阅管理、跨源聚合查询        |
| 存储后端 `image-cache/` 前缀 | 正文图压缩结果的去重缓存（key = URL + 参数的内容寻址，只是中间产物） | 重复图片不重复下载/编码；按 TTL 清理，可随时重建 |
| 存储后端 `fetch-cache/` 前缀 | feed 正文 + 条件请求验证器（key = URL 的哈希，只是中间产物） | 多个 owner 订阅同源时只出一次网；同 URL 覆盖写，可整体删除 |
### 为什么订阅关系在 CouchDB 而不在 PostgreSQL

最初的设计是把订阅关系放进 PostgreSQL，但它**与离线优先目标冲突**：离线阅读要求用户断网时也能
订阅/退订，这些改动先落在浏览器 PouchDB，联网后再与服务端合并。关系型表没有对应的客户端副本与
冲突合并机制，跨端修改无法收敛。因此订阅关系统一改由 CouchDB 用户库承载
（`subscription` 文档，客户端经回写通道推送），与已读/收藏状态复用同一条 PouchDB 双向链路。**PostgreSQL 侧没有
「某用户订阅了哪些 feed」的表**，也**没有全局的 `feeds` 注册表**：调度直接枚举各用户库的
`subscription:` 文档。`bot_feeds` 是 Bot↔源的关联（它是 Bot 独立抓取的依据，天然是 PG 数据）。

这条决定的直接后果：**同一个 URL 被 N 个 owner 订阅就是 N 行抓取任务**，没有"一份内容多处引用"。
它换掉的是整张订阅关系投影表 —— 那种表必须从客户端可写文档同步，会漂移，而它的唯一收益
（按源反查所有订阅者）在没有扇出的模型里已经不存在了。

同理 **Bot 的产出也不在 PostgreSQL**：抓取 job 把产出写进专属的 CouchDB `bot:{botId}` 库，
outbox 路由从该库的 `entries-by-date` 视图读取（见 `routes/bots.ts`），PG 中没有 `bot_outbox` 表。

**但 Bot 的身份数据仍在 PostgreSQL**，最要紧的是 **actor 密钥对**（Fedify 存在 `fedify_kv_v2`，键形如
`["_botkit", "bots", {username}, "keyPairs"]`）：删除 Bot 时由 `clearBotKv()` 一并清理 —— 只删 `bots`
表行的话，同名重建会复用旧私钥，而已分发给关注者的公钥无法撤回。

两条容易踩的约束：

- `bots.preferred_username` **必须有唯一约束** —— 它就是联邦标识符 `@username@域名`，ActivityPub
  的 acct 语义要求全局唯一；创建接口对重名返回 409。
- **Fedify 的表必须放在独立 schema（`fedify`）下，不能留在 `public`**：`fedify_kv_v2` 存着 Bot 的
  密钥对，留在 `public` 会被 `drizzle-kit push` 当成多余副本 DROP。做法与踩坑细节见
  [troubleshooting.md](docs/troubleshooting.md#drizzle-kit-push-要-drop-fedify_kv_v2会删掉-bot-私钥)。

## 文件存储职责

二进制文件有**两条完全不同的路径**，动手前先确认面对哪一类（正文图片不走对象存储）：

| 文件类型 | 存放位置 | 访问方式 |
| --- | --- | --- |
| 正文图片（抓取时压缩为 AVIF） | **CouchDB 附件**，跟随条目文档 | 随用户库同步到浏览器，供离线阅读 |
| 头像、Bot 头像、站点 logo | **存储后端**（`Storage` 接口） | 经 `/api/files/*` 代理读取，或配置公开域名直连 |

**为什么正文图片不放对象存储**：它要跟随条目文档同步进浏览器供离线阅读，作为 CouchDB 附件写入即与文档
同源同步，省掉独立下载与关联逻辑（代价是放宽附件大小上限，见 `index.ts`）。

**正文图片缓存的默认上限是「每篇 6 张 / 附件总体积 1MB」**：
按正文顺序取图，张数先到即停；压缩后体积超预算也停，首图必留。两道闸门都要保留——只限张数时大图可能
撑爆单条目体积，只限体积时异常多图的源会发出海量请求。抓取失败不阻塞、回退为无图条目。

**图片策略只有全局一份**（`rss/entry-images.ts` 的环境变量）。旧模型可按源覆盖（存在 `feeds` 表上），
那是「一个源被所有人共享、策略属于源」时代的产物；现在源属于每个 owner 自己，让「我调大我这个源的
图片张数」去影响别人没有意义，而给每个 owner 存一份策略又是新的投影表 —— 所以先只留全局默认。

**压缩结果按 URL + 参数内容寻址**（`images/cache.ts`）：同一条源图 + 同一组参数只下载、编码一次，正文里重复
出现的模板图（公众号文章内嵌的固定图等）因此不必每个条目都重下一遍。它只是抓取路径的**去重中间产物** ——
同一个源被多个 owner 订阅时，这张图只下载、编码一次。浏览器不直连外站图片，附件随用户库同步到本地，
拿不到附件时回填原始地址走网络（没有按需压缩接口）。
缓存对象按 `IMAGE_CACHE_TTL_DAYS` 由内建清理任务过期删除，删掉最多是下次遇到同 URL 时重下一遍 ——
所以它是**可随时重建的中间产物**，不属于任何需要保证的数据。

**正文图片的 `src` 必须在注入 DOM 之前就换成本地占位**（否则浏览器已按原地址发出请求）：
占位图用抓取时算好的 BlurHash、原始地址挂 `data-orig-src`、附件读出后再换 `blob:`。
具体渲染管线见 [frontend-list-rendering.md](docs/frontend-list-rendering.md#正文图片src-必须在注入-dom-之前换成占位)。

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

前端不经过 Nitro 代理后端：浏览器按 `NUXT_PUBLIC_API_BASE_URL` 直连后端（见 `useApi.ts`），同域部署下即反代
地址、cookie 同站。部署见 [docs/docker-deployment.md](docs/docker-deployment.md)、[deploy/Caddyfile](deploy/Caddyfile)。

## 数据流

1. **订阅**：`POST /api/feeds/discover` 解析校验 → 客户端把 `{ feedId, url, title }` 写进本地 PouchDB →
   同步到用户库的 `subscription:{feedId}`。**订阅关系的权威就在这份文档里**（含抓取地址）
2. **调度**：定时器枚举所有用户库与 Bot 库 → 每个 owner 读一次 `subscription:` 区间 + 一次
   `_local/schedule` → 按自适应间隔（15m→30m→1h→3h→6h，失败指数退避）判断哪些源到期 →
   入队 `(owner, feedId)` 的抓取 job（同一个 (owner, 源) 同时只有一个 job）
3. **抓取**：按 URL 查抓取缓存（TTL 内直接命中；否则带共享验证器发条件请求，304 就续 TTL）→
   feedsmith 解析 → 批量判存在 → 只写真正新增的条目（含 AVIF 附件，一次 multipart 写）→
   顺手把这个源裁到最新 N 条（`_purge`）→ 更新 `_local/schedule`
4. **用户同步**：登录后取库名（`GET /api/couchdb/sync-targets`）→ 对该远端库挂两条 live 通道
   （拉全量、只推状态）→ 首屏查本地库上屏；之后到达的条目折叠进「已同步 N 条」，点「查看」才换列表
5. **离线阅读**：PouchDB 本地缓存 → 离线浏览、跨源搜索 → 打开条目即标已读/切换收藏 →
   经回写通道同步到用户库 → 其他设备接收变更
6. **订阅一个 Bot**：客户端写 `subscription:bot:{botId}`（`kind: 'bot'`）→ 服务端把该 Bot 已有产出
   搬进用户库（订阅后立即调用一次；之后每次 Bot 有新产出都会搬）→ 条目 `_id` 保持
   `entry:bot:{botId}:{hash}`，已存在跳过（幂等）。退订时按同前缀 `_purge` 清掉
7. **ActivityPub 分发**：Bot 作为独立 owner 抓取，条目直接写进 **CouchDB `bot:{botId}` 产出库** →
   发布轮询从该库的 `entries-by-date` 视图读新条目 → 经 BotKit 构建 Create Activity 推送到 follower inbox

   > Bot 产出库的附件是**抓取时压缩好的**（不是从别处复制）：`bot_feeds` 自带源地址，Bot 自己抓、
   > 自己压图。写进 ActivityPub Create 的分发元数据只有标题、摘要、原文链接，
   > 远程实例自行拉取原始图片 URL —— 那是 outbox 载荷的形状，不代表产出库不存附件。
