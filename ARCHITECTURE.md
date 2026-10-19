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
        服务端（按需一次性复制）                          浏览器
  feed:{feedId-N} ─复制─▶ user:{userId} ─┬─live 拉取（全量）──▶ PouchDB 本地库
   （源库已裁到每条源最新 N 条；删除随复制传播；附件是抓取时的成品）└─live 回写（只推状态）◀─ （条目+订阅+已读收藏同库）
```

### 关键设计原则

- **一个用户一个库，聚合在服务端完成** — 用户专属库（库名随机，登记在 `user.timeline_db_name`；
  `_security.members.names = [userId]`）里的条目是源库的**独立副本**，附件连同 `images` 原样搬运；
  订阅与已读收藏也在这个库里。浏览器只对它挂两条 live 通道（拉取全量、回写状态）——订阅 3 个源和
  300 个源开销一样
- **搬运是按需的一次性复制，没有常驻任务** — 只在「源那边上次同步之后有过新内容」时对该源跑一次
  `POST /_replicate`（同步调用、跑完即止）；并发由我们的队列（`rss-timeline-sync`）控制，不再由 CouchDB
  复制器调度器决定。曾用「每个 (用户 × 源) 一条 `continuous` 复制」：625 条的追赶把 2 核机打垮，而改用
  `max_jobs` 限流又必然饿死（常驻任务永不结束、不释放槽位）。源/目标是带凭据的 URL，过滤用源库设计文档里的
  **JS filter**（Mango selector 不搬删除）；正文图走 CouchDB 内部 multipart 二进制、按源库修订谱系落库
  （`new_edits: false`）天然幂等
- **同步水位记在 PostgreSQL（`timeline_source_sync`），不是客户端可写的文档** — 判据是「没有水位行 /
  上次失败 / 源在**上次同步开始之后**有过变化（feed 看 `lastChangedAt`，它把"只裁剪删除"也算进来；
  bot 看 `lastNewEntryAt`）」（记开始时刻是为了不丢复制进行中写入的条目；记在订阅文档上会和客户端
  PouchDB 抢修订）；聚合库换了（重建/升级）水位整份作废。**复制不带任何参数**，所以复制哈希稳定 ——
  早期把时间下界塞进 `query_params` 的做法已废弃：那会让"换窗口 = 换哈希 = 从 0 重扫"，而且窗口过滤与
  源库保留变成两套权威
- **写方向由数据库层兜底，不靠客户端自觉** — 服务端独占写聚合产物（`entry:` / `feed:`）。用户库设计文档里的
  `validate_doc_update` 只放行 `_admin`（代理转发时是 `roles:[user]` 身份，见 `routes/couchdb.ts`），设计文档本身
  也只有 admin 能写 —— 客户端影子化/删除聚合条目在数据库层就会被拒，且关不掉这条规则
- **每用户一份冗余是明确取舍** — 用户量小，用磁盘换掉「客户端逐源合并 + 逐源调参」的全部复杂度；
  `feed:{feedId}` 仍是权威来源，用户库随时可重算：**重建 = 换一个空聚合库重搬**（复制是变更投递不是
  投影，就地清空搬不回来），用户写的订阅/已读收藏搬过去、旧库删掉，客户端因此要丢本地缓存重拉一遍
- **保留策略只有一个权威、只按源生效：每条源库裁到最新 N 条（N=50），删除随复制传播** —
  用户库和浏览器都是源库的**精确镜像**，它们不自己剪枝、不自己算窗口：源库删了哪条，下一次起
  复制就把那条 `_deleted` 变更送到目标端，用户库和 PouchDB 跟着删。抓取 worker 写完新条目后裁一次
  （按视图行序删最旧的 `total − N` 条，并列时间戳也能收敛），删除走**标准 delete 留墓碑**、不用
  `_purge`：墓碑是"删除能传播"以及"重扫不复活已删条目"的载体，purge 会擦掉修订记忆、让下游把删掉的
  文档重新搬回来。
  于是没有"按用户调窗口/保底条数"这回事，也没有"改了设置要重建"这条链路（`user_timeline_settings`
  只剩 AI 摘要开关）。用户库随时可由源库重算：**重建 = 换一个空聚合库重搬**（复制是变更投递不是投影，
  就地清空搬不回来）。图片策略（张数硬顶、体积预算、宽度、AVIF 质量、源图上限）只有 per-feed 一份
  （`feeds` 表，管理员维护）：**抓取时压一次写进源库，聚合只搬运**，同一张图在所有用户库里字节一致，
  图片成本与用户数无关
- **源库墓碑会被清理，但只在"所有活跃订阅者都已越过它"之后** — 墓碑只增不减会让首搬/重建越搬越重。
  清理的前提是墓碑的发现时间早于**所有活跃订阅者最近一次成功同步的开始时刻**（再留 grace）；
  被挡住的源会 nudge 订阅者再同步一轮（否则静默源永远停在"水位早于墓碑"）。订阅者一次复制里
  `doc_write_failures > 0` 时**不推进水位**，否则 GC 会清掉没投递成功的墓碑（用户库永久漏删）。
  这条安全窗依赖"订阅者水位一定会前进"，所以长期不活跃账号要**停止聚合**、回来时先**重建**派生库
  再恢复增量：暂停期间清掉的墓碑由重建重算，不走增量
- **Bot 做逻辑分组，feed 独立库做物理存储** — 一个 Bot 跟踪多个 feed、一个 feed 可被多个 Bot 引用，但每个 feed 物理上只存一份

### 用户库 `user:{userId}`：两类文档，两个写入口

服务端写聚合产物、客户端写自己的状态，同居一库（写方向见上）：

```
user:alice                                    写入口
  ├── feed:{feedId} / entry:{feedId}:{...}  →  源元信息与条目副本（含 AVIF 附件）  服务端
  ├── subscription:{feedId}                 →  { title, category }              客户端（离线也能改）
  ├── entry-state:{entryId}                 →  { read, readAt, saved }          客户端
  └── group-pref:{name}                     →  列表分组偏好                     客户端
```

**一条不变量：已读与收藏共用同一条文档**（`entry-state:{entryId}`），写入一律走 `usePouchDb` 的读改写（读最新
一版 → 只合并要改的字段 → 写回，409 则重读重算）；禁止「get 失败就当文档不存在、直接新建」—— get 也可能因
网络失败，那样新建会冲掉对端刚写入的收藏位。交互见 [frontend-list-rendering.md](docs/frontend-list-rendering.md#已读--收藏)。

### Bot 分组的逻辑视图 vs 物理存储

Bot 与 feed 是多对多，关联关系存储在 PostgreSQL `bot_feeds` 表中；物理上每个 feed 只有一个独立 CouchDB 库：

```
用户视角                              物理存储
Bot "技术早报" → feed:A、B、C   ┐
Bot "AI 动态"  → feed:A、D、E   ├──▶  每个 feed 一个独立库
单独订阅       → feed:F         ┘     （feed:A 只有一份）
```

浏览器按 Bot 展开时：拿 feedId 列表 → 直接查本地库（Bot 的 feed 属于该用户的订阅，条目已同步下来）——
零冗余，浏览器也不需要知道 feed 库的存在。

## 数据库职责划分

| 存储                      | 内容                          | 用途                     |
| ----------------------- | --------------------------- | ---------------------- |
| PostgreSQL（Drizzle）    | 用户与认证、`bots`/`bot_feeds`/`bot_inbox`、`feeds` 注册表、`site_settings`、`user_timeline_settings`、Fedify KV | 核心业务、认证、关系与元数据 |
| CouchDB feed:{feedId}   | 单个订阅源的 FeedDoc + EntryDoc（正文图片作为附件随文档存放） | RSS 内容权威来源，每源独立库            |
| CouchDB user:{id}       | 该用户订阅范围的条目**镜像**（源库裁到每源最新 N 条后的副本，附件沿用源库成品）+ FeedDoc 副本 + 订阅关系 + read/saved 状态 | 服务端聚合结果与用户状态同居一库，客户端只同步这一个库 |
| CouchDB bot:{botId}     | Bot 的产出文档（ActivityPub outbox 的内容源） | Bot 分发与 outbox 查询 |
| PouchDB（浏览器）           | 上述用户库的本地副本（条目 + 订阅 + 已读收藏）           | 离线阅读、离线订阅管理、跨源聚合查询        |
| 存储后端 `image-cache/` 前缀 | 正文图压缩结果的去重缓存（key = URL + 参数的内容寻址，只是中间产物） | 重复图片不重复下载/编码；按 TTL 清理，可随时重建 |
### 为什么订阅关系在 CouchDB 而不在 PostgreSQL

最初的设计是把订阅关系放进 PostgreSQL，但它**与离线优先目标冲突**：离线阅读要求用户断网时也能
订阅/退订，这些改动先落在浏览器 PouchDB，联网后再与服务端合并。关系型表没有对应的客户端副本与
冲突合并机制，跨端修改无法收敛。因此订阅关系统一改由 CouchDB 用户库承载
（`subscription` 文档，客户端经回写通道推送），与已读/收藏状态复用同一条 PouchDB 双向链路。**PostgreSQL 侧没有
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
同源同步，省掉独立下载与关联逻辑（代价是放宽附件大小上限，见 `index.ts`）。

**正文图片缓存的主约束是「每篇附件总体积预算」**（默认 1MB，见 `feeds` 表的图片策略列）：按正文顺序累计，
超预算即停止缓存后续图片、首图必留（用体积而非张数，因为小图能存几十张而大图自然少存；张数只作请求数硬顶）。
**策略只作用于抓取路径** —— 用户库里的附件是它的副本；抓取失败不阻塞、回退为无图条目。

**压缩结果按 URL + 参数内容寻址**（`images/cache.ts`）：同一条源图 + 同一组参数只下载、编码一次，正文里重复
出现的模板图（公众号文章内嵌的固定图等）因此不必每个条目都重下一遍。它只是抓取路径的**去重中间产物**：
浏览器不直连外站图片，附件随用户库同步到本地，拿不到附件时回填原始地址走网络（没有按需压缩接口）；
缓存对象按 `IMAGE_CACHE_TTL_DAYS`（默认 7 天）由内建清理任务删除，删掉最多是下次遇到同 URL 时重下一遍。
7 天是实测拐点：重复出现的模板图间隔 99% 在 6.6 天内，TTL 再长命中率只多 0.2pp、稳态体积却翻几倍。
诊断入口见 `scripts/diagnose-image-cache.ts` 头部注释。

**正文图片的 `src` 必须在注入 DOM 之前就换成本地占位**：`<img>` 一进 DOM，浏览器就按 `src` 发起请求，
之后再换只是取消它（现象是"打开一篇已缓存的文章仍然在打源站"，DevTools 里全是 `ERR_ABORTED`）。
占位图用抓取时算好、随 `images` 落库的 BlurHash（老条目没有则退化为 1×1 透明），原始地址挂在
`data-orig-src` 上；附件字节读出后再由前端管线换成 `blob:`，读不到就回填原始地址走网络。

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

1. **RSS 资讯聚合**：用户发现并订阅感兴趣的 feed → feedsmith 解析 → 写入对应 feed:{feedId} 库（去重）→ BullMQ 定时调度周期性拉取更新
2. **服务端聚合**：抓新条目 → 通知聚合队列（节流 30s，另有定时兜底与客户端催促）；一次聚合 = 对齐订阅与水位（退订清内容与水位、新订阅/有更新的源判为脏源）→ 更新状态文档 → 把脏源交给单源同步队列，由它限并发地跑一次性复制；没有新内容的源**一个复制请求都不发**，搬运完成后新条目由拉取通道自动到端
3. **用户同步**：登录后取库名（`GET /api/couchdb/sync-targets`）→ 对该远端库挂两条 live 通道（拉全量、只推状态）→ 首屏查本地库上屏；之后到达的条目折叠进「已同步 N 条」，点「查看」才换列表
4. **离线阅读**：PouchDB 本地缓存 → 离线浏览、跨源搜索 → 打开条目即标已读/切换收藏 → 经回写通道同步到用户库 → 其他设备接收变更
5. **ActivityPub 分发**：Worker 抓取到新条目 → 查 PostgreSQL `bot_feeds` 找出引用该 feed 的 Bot → 对每个 Bot 通过 BotKit 构建 Create Activity 推送到 follower inbox → 同时写入该 Bot 的 **CouchDB `bot:{botId}` 产出库**供 outbox 查询（`entries-by-date` 视图按 publishedAt 排序，天然支持倒序分页）

   > **Bot 产出库的附件是从 feed 库复制过来的**（不是重新压缩）：订阅了 Bot 的用户，其用户库以 Bot 产出库
   > 为源，同样靠「原样搬运」拿到图。写进 ActivityPub Create 的分发元数据只有标题、摘要、原文链接，
   > 远程实例自行拉取原始图片 URL —— 那是 outbox 载荷的形状，不代表产出库不存附件。
