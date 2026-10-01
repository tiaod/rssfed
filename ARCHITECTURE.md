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

### 正文图片的缓存策略

抓取时压缩为 AVIF 附件，与条目文档一次写入（`multipart.insert`），失败不阻塞抓取、回退为无图条目。
取舍的**主约束是「每篇附件总体积预算」**（默认 1MB，per-feed 可覆盖 `max_entry_image_bytes`）：
压缩后按正文顺序累计，超预算即停止缓存后续图片，首图必留。

为什么用体积而不是张数：小图（实测 p50 约 19KB）能存几十张，大图自然少存，比固定张数更贴近真实成本。
实测模拟（见 `report/image-cache-diagnosis`，`--simulate`）：1MB 预算覆盖 93.4% 的正文图、被截断 140 条，
而原来的「每篇 5 张」只有 48.1%、被截断 2420 条。`max_image_count` 因此退化为**请求数硬顶**（默认 200）——
预算要压完才知道大小，靠它兜住异常多图的源。

诊断与可观测：`scripts/diagnose-image-cache.ts` 只读扫描全部 `feed_*` 库给出命中率/失败归因，
worker 侧则在有失败时打一行 `[EntryImages] feed=… 候选=… 失败=… 原因[too-large=2 …]`。
这两处是排查「为什么这张图没缓存」的入口（原先 8 条失败路径全是静默 `return null`）。

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

## 前端列表渲染（四种视图 + 虚拟化 + 无限滚动）

时间线、分类页、单源页、Bot 产出页共用 `packages/nuxt-client/app/components/EntryList.vue`：
**四种视图（瀑布流 / 博客文章 / 列表 / 图片）共用同一套虚拟化外壳** + 页尾骨架触底加载。
数据侧由 `useSyncedEntryList`（列表只在 `load()` 里整体替换，`grow()` 只往末尾接更旧的条目）
与 `useInfiniteList`（单飞防重入）提供。

### 虚拟化（为什么必须做）

列表用 **Nuxt UI 的 `ScrollArea`**（`items` + `virtualize`，内部就是 `@tanstack/vue-virtual` 的
官方封装，见 `packages/nuxt-client/app/components/EntryList.vue`），只渲染视口附近的条目：
`lanes` 按断点给列数，`estimateSize` 估算未测量过的条目，真实高度由 ScrollArea 内部
`measureElement` 在渲染后记住。

选它而不是自己接 virtualizer：虚拟化这层逻辑（测量、overscan、scrollMargin、lanes 分配）
交给官方组件维护，升级 Nuxt UI 自动跟进。**没有用 `ScrollArea` 的地方只剩一点**：它自带滚动
容器，所以外层要给它确定高度（页面里是 `flex-1 min-h-0` 的列表容器 + 组件内 `h-full`）。

瓶颈不在滚动本身（滚动由合成器线程负责，DOM 多少都一样是满帧），而在**追加一批时要把整棵
已有 DOM 重新布局**，成本随条数线性上涨。手机视口（393px → 1 列）+ CDP CPU 降速 6x 实测：

| 条数 | DOM 节点（前 → 后） | 加载时长任务（前 → 后） |
| --- | --- | --- |
| 600 | 6975 → **196** | 5 次 / 76ms → **0** |
| 1200 | 13937 → **196** | 12 次 / 133ms → 1 次 / 50ms |

桌面 8 列同样恒定（801 节点，0 掉帧）。

> `content-visibility: auto` 那类"跳过视口外元素"的取巧方案试过，不够用：600 条有效，1200 条
> 仍有 111ms，而且滚动 P95 从 18ms 涨到 25ms（视口外元素滚进来要即时布局）。已放弃。

### 四种视图共用一套虚拟化外壳

`EntryList` 接一个 `view` prop（`masonry` / `blog` / `list` / `image`，见 `app/utils/listViews.ts`），
只切换 **item 渲染组件** 与 **布局参数**（`lanes` / `gap` / `estimateSize`），虚拟化、页头跨列、
页尾骨架触底、浮层锚点这些逻辑一份不动。切换按钮（`ListViewSwitcher`）放在各页导航栏的同步按钮旁。

**没有直接用 `UBlogPosts` / `UPageList` 当容器**，因为颗粒度对不上：虚拟化要的是「index → 一个 DOM
块」的映射（ScrollArea 决定渲染哪些 index，再对每个 index 调一次 slot），而这两个组件是
「数组 → 一整块 DOM」（`v-for` 全量渲染）。把全量条目交给它们就等于放弃虚拟化；自己算窗口再喂
给它们，则要面对它们写死的 grid 列数（`sm:grid-cols-2 lg:grid-cols-3`）和自己按视口算的 lanes 对不上。
`UBlogPosts` 的可视规格本身 ≈ `UBlogPost × N` + 一个 grid class，所以**复刻版式即可，容器不要**。

各视图的估算口径必须和实际渲染高度一致（`estimateSize` 参与泳道分配，估不准列尾就参差）：

| 视图 | 版式 | 手机列数 | 高度来源 |
| --- | --- | --- | --- |
| 瀑布流 | 封面按原比例，卡片高矮不一 | 2 | 有封面 320 / 无封面 180 |
| 博客文章 | 多列等高卡片：封面压成 `h-36` 横条 + 标题摘要各截断 2 行 + 卡片固定 `h-[22rem]`；单列（<768px）不强制等高、没有封面也不留占位带 | 1 | 多列写死 352；单列按有无封面 336 / 192 |
| 列表 | 紧凑单行：小缩略图 + 标题 + 两行摘要 | 1 | 写死 96（行高固定） |
| 图片 | 按封面真实比例的瀑布流（不裁切） | 2 | 泳道宽度 ÷ 该条封面宽高比 |

图片视图的比例取自列表查询 `images` 投影里**压缩后的 width/height**，所以图片还没加载时首帧布局
和总高度就是对的（Nuxt UI 官方的 masonry 例子给的是常数估算，靠渲染后测量纠正）。没有封面或
缺尺寸元信息的条目按 4:3 占位、**不过滤掉**——每页条数稳定，触底加载的节奏才不会被打乱。

博客视图那条约 144px 的封面带（没有封面时也补一条）只为**多列行对齐**服务；单列没有行可对齐，
占位带折叠、卡片高度交回内容（估算也按有无封面分档），免得白白占掉小半屏。

这一档的判据是**列数**而不是 CSS 断点：`EntryList` 把 `laneCount` 传给 item，占位带显隐与
卡片是否固定高度都由它派生。曾经用 `sm:`(640px) 写过，而博客的单列/多列边界是断点表里的
768px，640~767 这段就成了「已经是单列、占位带却还在」——一条边界写两处迟早会错开。

窄屏单独收档：手机上瀑布流两列（`masonry` 断点表 `0 → 2`），卡片只有 ~170px 宽，所以
封面高度区间、内边距、标题/摘要字号都按窄屏降一档（都用 `sm:` 还原，桌面不受影响），摘要限 4 行，
否则一行标题要折四五层。博客视图手机保持单列，两档版式一眼可分。

切视图会 `:key="view"` 重建 ScrollArea（布局算法换了，重建比留着上一版的测量值干净），代价是
回到顶部——正是切换视图时预期的位置。重建会让之前那个 ResizeObserver 盯上已卸载的节点，所以
量容器宽度、挂 observer 的那段逻辑做成可重入的（`syncViewportMeasurement`），切视图后重新挂。

### 视图默认值：三层 + 会话内覆盖

生效优先级（越具体越优先）：

    单源页 / Bot 产出页：订阅源 -> 所属分组 -> 全局
    分组页：            分组 -> 全局
    时间线：            全局（默认瀑布流）

存储位置分别是：全局在 `useSettings` 的 localStorage（`AppSettings.view`，通用设置页可改）；
订阅源在订阅文档上（编辑订阅弹窗里的「默认视图」，跟着用户状态库双向同步，不用改服务端 schema）；
分组新开一种用户状态库文档 `pref:group:<name>`（订阅管理页分组行的菜单）。分组是订阅文档上的
自由文本 `category`，所以分组改名后偏好会留在旧名字下成为孤儿，不做自动跟随。

**页面上的切换按钮只写会话内的 `useState` 覆盖**（`composables/useListView.ts`），刷新即回到配置值；
菜单里给「恢复默认视图」做会话内撤销。这样顺手点一下不会把配置改掉——默认值只能由三个显式入口修改。

### 页头随列表一起滚

单源页的订阅源描述 + 「访问网站」（`FeedHeader.vue`）不固定在列表上方，而是通过 `EntryList` 的
`header` prop + `#header` 插槽作为**虚拟列表的第 0 项**参与滚动：跟条目同在一个 `ScrollArea` 里，
往下读时一起移出屏幕。

难点在多列：虚拟化按泳道摆放条目，**单个 item 无法跨列**。页头因此按当前列数渲染同样多份——
只有第一份可见并撑满整行（`inlineSize: calc(lanes * 100% + (lanes-1) * gap)`），其余 `invisible`
但同样占高；于是每一列都从页头下方开始，视觉上是一条贯穿整行的页头，而不是被挤进第一列的格子。
列表为空时页头仍固定在「暂无条目」上方（没有可滚动的内容）。

### 「已同步 N 条」提示条：浮层 + 滚动方向显隐

同步只报数、不动列表（见 `useSyncedEntryList`），所以提示条 `NewEntriesBanner` 要同时做到
「看得见」和「不打断阅读」。列表页用它的 `floating` 形态：绝对定位盖在滚动区顶部、**不占布局
高度**，展开 / 收起既不推动内容也不惊动虚拟化（实测展开前后卡片位置与 `scrollHeight` 都不变）。

正因为不占布局，它才敢再叠一层滚动方向显隐（`useScrollHideOnDown`：下滑让位、上滑或回到顶部
露出）；页面在计数变化时调一次 `reveal()`，避免用户正好在下滑时漏掉这次通知。`reveal()` 之后
还有 1.2s 保护窗口——惯性滚动一秒能刷出几十个 scroll 事件，不留窗口的话新提示会被同一段下滑
手势立刻收走（实测表现是「闪一下就没，停手也不会回来」，用户只会觉得提示丢了）。

四个列表页（时间线、分类、单源、Bot 产出）都用这个浮层形态，页面侧统一走
`useEntriesBannerVisibility(count, anchorRef)`：它把方向显隐和「计数变化先露一次」组合在一起，
使用方只要给列表容器加 `relative`、给提示条传 `floating` + `:visible`。

组件仍保留常驻形态（`floating` 默认 false），但它**不按方向隐藏**：参与布局的元素改高度会让
滚动内容整体重排，虚拟化尤其怕这个（组件注释里记了试过的两版失败方案）。两种形态也都不能塞进
`EntryList` 的 `#header` 插槽——那样滚下去就看不见了，展开还会把正在读的内容推走。

浮层与列表分支的**渲染位置**也有讲究：它必须和列表容器一起提到空态 / 列表分支之外。列表为空时
同步带来第一批条目，`newCount` 已经变正却没有任何提示可点，页面会一直停在「暂无条目」
（`entries` 只在 `load()` 里更新，用户没有别的入口把它刷出来）。

### 页尾加载骨架 = 触底信号

`hasMore` 为 true 时，列表末尾排**每列一个**加载骨架（列数等于骨架数：虚拟化按「最矮泳道」分配，
N 个等高的骨架必然一列落一个，滚到底部时每列都有东西，也就不需要列尾补平）。它们当作普通条目
参与虚拟化，**任一骨架进入视口就等于「用户滚到底了」**，由 `EntryList` 里的
`useIntersectionObserver` 触发加载。

不用 `rootMargin` 提前 N 屏的原因：IntersectionObserver 的相交判定还要与 target 的所有滚动
祖先裁剪框求交，root 用隐式视口时内部滚动容器会把它挡住——实测「必须滚到底才触发」，把 root
换成滚动容器才有效，但真实布局里到底哪个元素在滚并不好判断。骨架可见这个信号本身就在容器
可视区内，绕开了这一整类问题。实现里只留 200px 的 `rootMargin` 当缓冲，不是提前几屏预加载。

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

## PWA（安装到手机）

站点可以装到手机主屏幕。应用名、图标、主题色全部取自管理员的「站点设置」，改配置不需要改代码或重新构建。

### 为什么 manifest 是动态的、但 URL 是固定的

`<link rel="manifest">` 必须**静态存在于 HTML 中**，并指向一个**同源** URL，内容由服务端按站点配置渲染：

- iOS Safari 只在文档加载时读取 HTML 里静态存在的 manifest，**不支持页面加载后 JS 注入**；`blob:` / `data:` URL 也不被浏览器接受。
- 安装时的图标抓取由**浏览器进程独立发起**，不经过页面 JS，所以图标必须是从服务端 URL 直接可取的图片。
- manifest 里 `start_url` / `scope` 的语义基于 manifest 所在的 origin，因此这个 URL 必须同源（生产由 Caddy 分流，开发由 `nitro.routeRules` 把 `/api/site-settings/**` 代理到后端）。

端点一览（全部挂在公开的 `/api/site-settings` 前缀下：免登录，且天然落在反代既有的 `/api/*` 规则内，无需为 `/manifest.webmanifest` 单独放行）：

| 端点 | 作用 |
| --- | --- |
| `GET /manifest.webmanifest` | 动态 manifest（`no-cache` + ETag，配置改完立即生效） |
| `GET /icon/192.png`、`/icon/512.png` | 普通图标：透明底、保持宽高比居中 |
| `GET /icon/maskable-512.png` | Android 自适应图标：缩进中心 80% 安全区 + 不透明底 |
| `GET /icon/apple-touch-180.png` | iOS 主屏幕图标（`<link rel="apple-touch-icon">`）：强制不透明 |

### 图标由 sharp 在服务端实时生成

`packages/hono-server/src/pwa/render.ts` 负责渲染，`icons.ts` 负责取源与缓存。取源优先级：**独立方形图标（附件 → URL）→ 站点 logo（附件 → URL）→ 内置默认图形**。

几处不能省的细节：

- **`sizes` 声明必须与实际像素严格一致**：Chrome 会校验，不符则该图标被静默丢弃，表现为「manifest 看着没问题，就是装不上」。故 `ICON_SPECS`（`pwa/manifest.ts`）是 manifest 声明与图标输出的**共同真源**，`renderIconPng` 结束前还有一道尺寸自校验。
- **maskable 不能复用普通方图**：Android 会按自己的形状裁切，贴边图形会被切掉。
- **apple-touch 必须不透明**：iOS 会把透明区域填黑，生成时用 `flatten` 去掉 alpha 通道。
- **内置默认图形用纯几何路径而非 `<text>`**：容器镜像里未必装了字体，librsvg 缺字体时文字会整块不渲染，而渲染失败是静默的（表现只是主屏图标空白）。前景色按底色亮度自动取黑/白。
- **生成结果按「图标源 + 规格」做进程内 LRU 缓存**：512 图每次约几十毫秒，而图标会被反复抓取。server 单副本，不存在多副本不一致。
- 手填外链图标源时限制协议、超时（5s）与体积（5MB）。

### 配置字段与回退链

`site_settings` 表为此新增 6 列（`pnpm db:push`）：`pwa_short_name`、`pwa_display`、`pwa_theme_color`、`pwa_background_color`、`pwa_icon_url`、`pwa_icon_attachment_id`。全部可空，逐级回退：

| manifest 字段 | 回退链 |
| --- | --- |
| `name` | `site_title` → `RSSFed` |
| `short_name` | `pwa_short_name` → `site_title`（截断至 12 字符） |
| `description` | `description` → 内置默认 |
| `theme_color` | `pwa_theme_color` → `primary_color` → 内置绿 |
| `background_color` | `pwa_background_color` → `primary_color` → 白 |
| `display` | `pwa_display` → `standalone`（非法值一律回退） |

上表是**字段级**回退。另有一层**读取级**兜底：`loadPwaRow()` 查库失败时（连接抖动、迁移还没落地导致 `pwa_*` 列尚不存在、发布窗口期）按「全空配置」处理，manifest 与图标照样返回内置默认值。安装 PWA 是纯读路径，降级成默认应用比整个端点 500 更有价值；写入路径不降级，管理员的保存失败仍会明确报错，避免配置静默丢失。

管理入口：「个人资料 → 站点设置」（管理员）。

### 与 Service Worker 的关系

两者独立：**SW 让已访问过的页面离线可开，manifest 让应用能装到主屏幕**。manifest 与图标路径命中 SW 的 `API_CACHE_PATTERNS`（`/^\/api\/site-settings/`），走网络优先 + 落缓存，断网时也能读到。

> SW 只在安全上下文生效，所以手机上要真正离线可用必须走 HTTPS；通过局域网 `http://192.168.x.x:3000` 访问开发服务器时，manifest 能读到，但装不上、也离线不了。
