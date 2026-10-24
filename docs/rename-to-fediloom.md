# RSSFed → FediLoom（织阅）改名评估

> 目标：把项目名从 `rssfed` / `RSSFed` 改成 `fediloom` / `FediLoom`（中文品牌「织阅」），
> 量化影响面，并给出可分批执行、可回滚的顺序。
>
> 口径（2026-10-24，工作区真实状态）：

```bash
grep -rin rssfed --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=.nuxt --exclude-dir=.output --exclude-dir=dist --exclude-dir=coverage .
# 84 个文件 / 368 处（大小写不敏感，含 docs/ 与未入库的 report/）
```

## 结论

**难度：中低（1 人日可完成「看起来完全改名」，3–5 人日才能收口全部数据身份）。**

理由是两句话：

1. **大部分是机械替换**：368 处里，文档 + 测试/脚本/report 留档 + 用户可见显示串占 225 处，
   改错也只是显示变旧或脚本跑不起来，不动任何数据。
2. **真正的成本只有两块**——**数据身份**（PouchDB 本地库名、Docker 具名卷、Postgres 库/角色）
   和**部署身份**（compose project 名、镜像路径）。前者能不改就不改，后者改错会让发布自锁。
   而**联邦身份（`@bot@域名` / actor id）不能动**：它由 `BOTS_BASE_URL` + DB 里的
   `preferred_username` 派生，跟品牌字符串无关，换品牌名不会影响它；但如果顺手换域名，
   已分发的 actor 无法迁移，关注者只能重新关注。

一句话取舍：**显示层随便改，包名/镜像名可以改，数据与部署身份建议只改展示、不改存储。**

**落地节奏**：阶段 0（后台改配置，约 5 分钟，不用发版）→ 阶段 1+2（半天到一天，发一次版）
→ 阶段 3（可选，多数建议不做）。每阶段独立可回滚，详见第四节。

## 一、品牌面现状：运行时配置 vs 写死

运行中的部署，可见品牌**基本**由 `site_settings` 表驱动，代码里只剩兜底。证据：

| 展示位置 | 数据来源 | 证据 |
| --- | --- | --- |
| PWA manifest `name` / `short_name` | `siteTitle` / `pwaShortName`，都空则 `DEFAULT_APP_NAME` | `packages/hono-server/src/pwa/manifest.ts:34,151-156` |
| manifest `theme_color` / `background_color` | `pwaThemeColor` → `primaryColor` → 内置色 | `packages/hono-server/src/pwa/manifest.ts:150`（`resolvePwaConfig`） |
| iOS 主屏幕名 `apple-mobile-web-app-title` | `pwaShortName` → `siteTitle` → `'RSSFed'` | `packages/nuxt-client/app/app.vue:33-35` |
| 站点 logo / PWA 图标 | `logoUrl` / `pwaIconUrl` / 内置几何图标 | `packages/hono-server/src/db/schema.ts:41,61`；`manifest.ts:67` 的 `ICON_SPECS` |
| 浏览器标签页 `<title>` | **写死 `'RSSFed'`，不读配置** | `packages/nuxt-client/app/app.vue:58-61` |
| 登录/落地页页头、页脚、空列表标题 | 写死 `'RSSFed'` | `layouts/none.vue:19,60`；`pages/index.vue:90` |
| 欢迎通知标题 | 写死 `'欢迎使用 RSSFed'` | `components/NotificationsSlideover.vue:32` |
| 后台品牌表单 placeholder | 写死 `'RSSFed'` | `components/admin/SiteSettingsManager.vue:285,382` |

`site_settings` 相关列：`siteTitle` / `description` / `logoUrl` / `primaryColor` / `pwaShortName` /
`pwaDisplay` / `pwaThemeColor` / `pwaBackgroundColor` / `pwaIconUrl`（`packages/hono-server/src/db/schema.ts:38,41,45,53,55,57,59,61`）。

**顺带发现一个改名前就存在的缺口**：`siteTitle` 只进 manifest 与 iOS 主屏幕名，**没接到
`useSeoMeta`**——仓库内只有 `app.vue:58-61` 一处设置 `title`，且是常量。也就是说
「`siteTitle` 驱动页面标题」这个说法在代码层面不成立（`useSiteSettings` 拉的是运行时配置，
但没有任何 `useHead` 消费它）。阶段 1 应顺手补上（首屏是 SSR，客户端配置到达前会先渲染默认名，
要接受一次标题闪变，或改由服务端注入；这是产品取舍，不是改名本身的要求）。

## 二、全量清单

按性质分 9 类（同一文件若跨类，归入其主要用途；合计 84 文件 / 368 处）：

| 类别 | 文件数 | 出现次数 | 风险档 | 代表位置 |
| --- | --- | --- | --- | --- |
| (a) 用户可见显示串 | 8 | 12 | T0 | `app.vue:34,59`、`none.vue:19,60`、`index.vue:90` |
| (b) npm 包名与构建面 | 4 | 15 | T1 | `package.json:2,7-8,13-15`、`Dockerfile:48-49,73` |
| (c) 持久化/本地数据身份 | 13 | 74 | T2 | `utils/localDbName.ts:26`、`public/sw.js:20`、`docker-compose.yml:7-9` |
| (d) 部署身份 | 7 | 44 | T2 | `docker-compose.prod.yml:23`、`.doco-cd.yml:30`、镜像路径 |
| (e) 对外 API/协议面 | 6 | 10 | T1/T3 | `routes/mcp.ts:78`、`services/api-token.ts:16`、UA |
| (f) ActivityPub 联邦身份 | **0** | **0** | 禁改 | 由 `BOTS_BASE_URL` + `preferred_username` 派生 |
| (g) 认证 cookie | **0** | **0** | 无需改 | Better Auth 默认前缀 `better-auth` |
| (h) 测试/脚本/report 留档 | 33 | 101 | T0–T2 | 3 个测试文件锁定真实名字，其余是 fixture |
| (i) 文档 | 13 | 112 | T0 | `docs/` 10 个文件 + `README`/`ARCHITECTURE`/`AGENTS` |

### (a) 用户可见显示串（8 文件 / 12 处）

| 文件:行 | 内容 | 风险 |
| --- | --- | --- |
| `packages/hono-server/src/pwa/manifest.ts:34` | `DEFAULT_APP_NAME = 'RSSFed'`（全空配置的 PWA 兜底名） | T0 |
| `packages/nuxt-client/app/app.vue:34` | `appTitle` 兜底 `'RSSFed'` | T0 |
| `packages/nuxt-client/app/app.vue:59` | `useSeoMeta({ title: 'RSSFed' })`——`document.title` 写死 | T0（见上文缺口） |
| `packages/nuxt-client/app/layouts/none.vue:19,60` | 页头品牌链接、页脚 `RSSFed • 年份` | T0 |
| `packages/nuxt-client/app/pages/index.vue:90` | 无订阅空态 `<h1>` | T0 |
| `packages/nuxt-client/app/components/admin/SiteSettingsManager.vue:285,382` | 站点标题/主屏幕名 placeholder | T0 |
| `packages/nuxt-client/app/components/NotificationsSlideover.vue:32` | 欢迎通知标题 | T0 |
| `packages/nuxt-client/app/components/settings/McpSetupPanel.vue:197` | 文案「接入你的 RSSFed 订阅」 | T0 |
| `packages/nuxt-client/app/components/settings/McpSetupPanel.vue:136` | MCP 配置示例里的客户端 key `rssfed:`（用户本地配置项名，不是服务端标识） | T0 |
| `packages/hono-server/src/routes/site-settings.ts:200` | 注释里的「应用名 RSSFed」 | T0 |

品牌资产只有 `packages/nuxt-client/public/favicon.ico` 一个静态文件；PWA 图标是服务端按
`site_settings` 运行时用 sharp 生成的（`packages/hono-server/src/pwa/render.ts:15`，
路由 `routes/site-settings.ts:265`），没有需要改名的构建资产。

### (b) npm 包名与构建面（4 文件 / 15 处）

- 根 `package.json:2`（`"name": "rssfed"`）与 5 处脚本 filter：`:7-8,13-15`。
- `packages/nuxt-client/package.json:2`（`@rssfed/nuxt-client`）、`packages/hono-server/package.json:2`（`@rssfed/hono-server`）。
- `Dockerfile:48-49,57,73` 的 `pnpm --filter @rssfed/...`；`:3,10-11` 是注释与本地 tag 示例。
- 三个脚本的用法注释：`packages/hono-server/scripts/rebuild-feed-icons.ts:17-18`、`verify-schema.ts:92`、`diagnose-image-cache.ts:23-24`。

**关键事实**：`pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 里 **0 处** `rssfed`——lock 的 importers
按**路径**（`packages/hono-server` / `packages/nuxt-client`）索引，两个包之间也**没有**
`workspace:` 相互依赖。所以包名是纯构建内标识，改掉不触发依赖图/ lockfile 变化。

### (c) 持久化 / 本地数据身份（13 文件 / 74 处）

这才是「改名 = 换数据」的部分，逐项：

| 项 | 证据 | 说明 |
| --- | --- | --- |
| PouchDB 本地库名 `rssfed-timeline-<uid>` | `packages/nuxt-client/app/utils/localDbName.ts:26`；`usePouchDb.ts:591` | 每账号一个库，装整份用户库（条目 + 订阅 + 已读收藏） |
| localStorage 键 | `localDbName.ts:37`（refresh）、`:48`（上次远端库地址） | 后者丢了会让本地镜像与新库修订谱系对不上 |
| 迁移标记 `rssfed-central-migrated-v5` | `usePouchDb.ts:644,660` | 旧库/旧键清理的一次性开关 |
| 历史库前缀/键前缀 | `localDbName.ts:52,65,86-88`；`usePouchDb.ts:404,422,665` | 升级清理逻辑，改名后会把旧「当前库」当成历史库删掉 |
| SW 缓存名前缀 | `packages/nuxt-client/public/sw.js:20`（`CACHE_NAME = rssfed-${CACHE_VERSION}`）、`:82`（activate 只删 `rssfed-` 前缀） | 静态资源/少量只读接口缓存 |
| SW dev 清理前缀 | `packages/nuxt-client/app/plugins/service-worker.client.ts:28` | 同前缀 |
| CouchDB `_replicator` 历史文档 id 前缀 | `packages/hono-server/src/couchdb/replicator.ts:41`（`REPLICATION_PREFIX = "rssfed-"`）、`:57-58,69,249,278-280` | **新实现不再创建**，仅用于升级清理旧常驻复制 |
| Postgres 连接串默认值 | `packages/hono-server/src/db/index.ts:6`；`drizzle.config.ts:19`；`bots/index.ts:25`；`scripts/merge-user-state-into-timeline.ts:91` | 兜底库名 `.../rssfed` |
| dev 库/角色/卷 | `packages/hono-server/docker-compose.yml:7-9,11,13,26,58,71,74,120-123` | 静态卷名 `rssfed-db` 等，仅本地开发 |
| S3 桶 | `packages/hono-server/.env.example:140-142`；`.env:58-60`；`seaweedfs-s3.json:7-8`（dev 凭据） | 桶名 + dev access key |
| CouchDB 代理 vendor/version | `packages/hono-server/src/routes/couchdb.ts:89-90`（`version: "rssfed-proxy"`、`vendor.name: "RSSFed"`） | 见 (e) 的兼容性说明 |
| 服务端 CouchDB 库名 | **不含品牌**：前缀是 `feed_` / `bot_` / `user-timeline_`（`packages/hono-server/src/db/constants.ts:13,14,22`） | 这是好消息：CouchDB 侧无需改名 |

注：内部头 `x-rssfed-user-id` 按主用途归入 (e)——它是**进程内约定**（入口层注入、MCP handler 读取），
不落盘、无外部调用方，改它不需要迁移。

### (d) 部署身份（7 文件 / 44 处）

| 文件:行 | 内容 |
| --- | --- |
| `docker-compose.prod.yml:23` | `name: rssfed-prod`——决定 **5 个具名卷**的真实名字（`rssfed-prod_postgres-data` / `-couchdb-data` / `-redis-data` / `-uploads-data` / `-seaweedfs-data`，声明在 `:310-314`），容器名同样带这个 project 前缀（`rssfed-prod-server-1` 等） |
| `docker-compose.prod.yml:36,38,42` | Postgres `POSTGRES_USER/DB= rssfed`、健康检查 `-U rssfed -d rssfed` |
| `docker-compose.prod.yml:203,221,272` | 镜像 `ghcr.io/tiaod/rssfed/{migrate,server,web}` |
| `docker-compose.prod.yml:208,237` | `DATABASE_URL` 兜底里的 `rssfed` 角色/库 |
| `docker-compose.prod.yml:80,86,90,97` | `RSSFED_DEPLOY_DIR` / `RSSFED_ENV_FILE` 插值 |
| `docker-compose.prod.yml:152` | 注释里的 compose 网络名 `rssfed-prod_default` |
| `.doco-cd.yml:8-10,30` | project 名 `rssfed-prod` 与「改名只能新建 project、手工迁移数据、旧卷才不丢」的明确警告 |
| `.doco-cd.yml:24-27,49,51` | `RSSFED_ENV_FILE`（容器内路径）/ `RSSFED_DEPLOY_DIR`（宿主机路径） |
| `.github/workflows/build-images.yml:107-109,119` | 镜像 tag 由 `github.repository` 派生（= `tiaod/rssfed`）；OCI title `rssfed-<target>` |
| `deploy/doco-cd.yml:1,5,60-63,77` | 服务器上的 doco-cd 编排：`~/rssfed` 目录、`git@github.com:tiaod/rssfed.git`、挂载 `/home/ubuntu/rssfed/.env.production` |
| `deploy/Caddyfile:2`、`deploy/couchdb-proxy-auth.ini:2` | 仅注释 |
| `.env.production.example:2,44,118` | 注释里的品牌名、`DATABASE_URL` 示例、S3 桶示例 |

### (e) 对外 API / 协议面（6 文件 / 10 处）

- MCP server 名：`packages/hono-server/src/routes/mcp.ts:78`（`serverInfo.name = "rssfed-subscriptions"`）。
- 内部头 `x-rssfed-user-id`：`mcp.ts:75`（读）、`:441`（写），`:71` 为注释。**仅进程内部**
  （入口层校验 Bearer token 后注入，再交给 MCP handler），没有外部调用方。
- API token 前缀：`packages/hono-server/src/services/api-token.ts:15-16`（`TOKEN_PREFIX = "rssfed"`），
  语义见 `db/schema.ts:83`。校验是整串 SHA-256（`api-token.ts:24-27,56-60`），与前缀无关。
- 出站 User-Agent：`routes` 之外两处——`packages/hono-server/src/rss/parser.ts:309`（`RSSFed/0.1.0`）、
  `packages/hono-server/src/images/fetch.ts:121`（`Mozilla/5.0 (compatible; rssfed/1.0)`）。
- CouchDB 代理根信息：`routes/couchdb.ts:89-90`。
- GitHub issues 外链：`packages/nuxt-client/app/components/UserMenu.vue:62`。

**需要澄清一个容易传错的说法**：MCP **工具名没有** `rssfed_*` 前缀。`mcp.ts` 里 19 个
`registerTool` 全是裸名（`list_subscriptions`、`discover_feed`、`add_subscription` …）。
带 `rssfed_` 前缀的是 `docs/archive/dsh-mcp-bridge.md:119-137,141` 里**尚未实现**的
dsh 桥接插件方案（那份文档自己就写了「加前缀避免与 dsh 内置工具冲突」）。所以对外工具面
目前只有 `serverInfo.name` 一个字符串，改名不影响任何工具调用契约。

### (f) ActivityPub / 联邦身份（0 处，且必须保持为 0）

- origin：`packages/hono-server/src/bots/index.ts:9`（`process.env.BOTS_BASE_URL ?? "http://localhost:3001"`）。
- 用户名/显示名：`:52-57`，来自 DB 的 `bots.preferred_username` / `name`。
- actor id、webfinger、key 对由 BotKit/Fedify 基于 origin 派生；私钥在 `fedify_kv_v2`
  （`bots/index.ts:78-96`；`ARCHITECTURE.md:146-148`），`preferred_username` 唯一性就是 acct
  语义（`ARCHITECTURE.md:152-153`）。
- `bots/index.ts:25` 里唯一的 `rssfed` 是 `DATABASE_URL` 兜底，属于 (c)，不是身份。

结论：**改品牌字符串完全不动联邦身份**；但既然改名的常见做法会顺带换域名，必须单独说清楚：
一旦 `PUBLIC_URL` / `BOTS_BASE_URL` 换成新域名，actor id 与 `@user@domain` 全部变化，已关注者
无法迁移（远程实例按 acct 解析，旧 actor 404），只能通知关注者重新关注。**建议域名保持不变。**

### (g) 认证 cookie（0 处）

`packages/hono-server/src/auth.ts:7-27` 只配置了 `emailAndPassword`、`trustedOrigins`、`baseURL`，
**没有** `advanced.cookiePrefix`、`appName` 或任何品牌字段；源码里也搜不到 `cookiePrefix` / `appName`。
Better Auth 的 cookie 前缀默认是 `better-auth`（`node_modules/better-auth/dist/cookies/index.mjs:28`），
与品牌无关。`trustedOrigins` 来自 `CORS_ORIGINS`（`src/config.ts:7-11`），值由部署域名决定，
代码不含品牌。→ 改名**不影响登录态**；只有换域名才需要重新配置 CORS/`PUBLIC_URL`。

### (h) 测试 / 脚本 / report 留档（33 文件 / 101 处）

| 子类 | 文件数 | 处数 | 说明 |
| --- | --- | --- | --- |
| **锁定真实名字的测试** | 3 | 38 | `__tests__/utils/localDbName.test.ts`（26，断言 `rssfed-timeline-*`、legacy 名字）、`__tests__/timeline-replication.test.ts`（7，断言复制文档 id 前缀）、`__tests__/mcp.test.ts`（5，断言 `serverInfo.name` 与内部头） |
| fixture 型测试（改不改都能过） | 11 | 23 | `usePouchDb.*.test.ts`（7 个文件 / 18，测试自己的 stub 键）、`mapView.test.ts`（1）、`fetch-proxy.test.ts`（1，URL 里的库名只是路径）、`pwa-manifest.test.ts`（2，`:166,174` 的 `"RSSFed 演示"` 是任意 fixture；`:68-69` 断言的是常量）、`useTimelineCloudInfo.test.ts`（1，fixture） |
| 验证脚本 | 10 | 22 | `verify-timeline-sync.mjs:68,308,315,394,634`（复制前缀、临时邮箱）、`verify-entry-images.mjs:40,143`（playwright profile 目录、IndexedDB `_pouch_rssfed-` 过滤）、`verify-entry-route.mjs:30`、`verify-entry-reveal.mjs:42`；hono 侧 `diagnose-image-cache.ts`、`verify-mcp.ts`、`verify-mcp-slash.ts`、`rebuild-feed-icons.ts`、`verify-schema.ts`、`merge-user-state-into-timeline.ts` |
| `report/` scratch（`.gitignore:21` 未入库） | 9 | 18 | 硬编码 S3 桶、`psql -U rssfed -d rssfed`、容器名、以及绝对路径 `/home/tiaod/workspace/rssfed` |

注意：脚本把**服务端/浏览器真实名字写死**（复制前缀、IndexedDB 前缀、profile 目录、DB 名）。
阶段 3 改名后这些脚本会**静默失配**（跑得起来但查不到数据），不要漏改；`report/` 属临时证据，
需要时重跑即可，但其中硬编码的绝对路径在工作区目录改名后会直接失效。

### (i) 文档（13 文件 / 112 处）

`docs/` 共 10 个文件 107 处，其中：`docs/archive/dsh-mcp-bridge.md`（35）、
`docs/docker-deployment.md`（28）、`docs/troubleshooting.md`（27）、`docs/archive/ai-mcp-assistant.md`（8）、
`docs/notes/**`（6），其余 3 处分散（`docs/offline-and-pwa.md` 1、`docs/cloud-deployment-todo.md` 2）；
根目录 `README.md`（1）、`ARCHITECTURE.md`（3）、`AGENTS.md`（1）。

按 `AGENTS.md:38,45` 的约定，`docs/notes/` 与 `docs/archive/` 是**历史留档**（记录当时量到什么，
不是现行规范），建议**不改**：改了反而让「当时的命令/路径」失真。需要更新的只有现行文档：
`README.md`、`ARCHITECTURE.md`、`docs/docker-deployment.md`、`docs/troubleshooting.md`，
其中 `docs/docker-deployment.md:387` 与 `.doco-cd.yml:8-10` 的「project 名必须保持 `rssfed-prod`」
是一条**契约说明**，改品牌时必须同步改写措辞（但结论不变：不要改 project 名）。

## 三、风险分档与处置

### T0 纯显示（零风险）

(a) 类全部、`favicon.ico`、现行文档。改错只会看到旧名字，不动任何持久化数据。

### T1 代码内部标识，两侧同改一次部署

`x-rssfed-user-id`（同一进程 set/read）、MCP `serverInfo.name`（客户端只用于展示）、
包名 + Dockerfile `--filter`（构建内两侧）。这些都在同一个发布单元里，**一次部署即一致**，无迁移。

### T2 持久化 / 部署身份（需迁移或明确放弃）

**每一项的精确后果与可选处置：**

| # | 项 | 改名后果（对存量用户/数据） | 迁移 / 兼容选项 |
| --- | --- | --- | --- |
| 2.1 | PouchDB 本地库名前缀 `rssfed-timeline-` | 新前缀 = 每账号一个新空库：首次打开**整份重下**（条目 + AVIF 附件）；旧库不再被引用，若要回收空间需把 `rssfed-` 前缀加入 `LEGACY_LOCAL_DB_PREFIXES`（`localDbName.ts:65`）才会被清掉——清掉不可恢复（数据在服务端可重算，见 `ARCHITECTURE.md:71-72`）。测试自己的注释就写着「改名等于换库，老用户本地的条目要整份重下」（`localDbName.test.ts:11`） | A. **不动（推荐）**；B. 启动时本地库 `replicate` 旧→新 + 迁移标记（需覆盖 `guest`、账号切换、失败回退旧库名）；C. 接受重下（成本可量化：单用户 22531 文档 / 495MB，见 `docs/notes/sync/sync-watermark-diagnosis.md:142`，全量用户首屏会集中打服务端） |
| 2.2 | localStorage 键（refresh / 上次远端库地址 / 迁移标记） | refresh 键丢：最多多催一次聚合（无影响）；远端库地址键丢：本地镜像可能带旧修订与「换过的库」冲突，需重拉；迁移标记丢：清理任务重跑一次（幂等，仅多扫一遍 `allDbs()`） | 优先保留旧键名；必须改则读写双认（新键读不到读旧键并回写），迁移标记沿用旧名以免重跑 |
| 2.3 | SW 缓存前缀 `rssfed-` | 新 SW 的 `activate` 只删**新前缀**（`sw.js:82`），旧 `rssfed-*` 缓存**永不清理**：每个用户残留旧构建缓存（体积取决于构建产物与缓存过的接口响应），无数据丢失 | 过渡版本同时删两个前缀（`rssfed-` + `fediloom-`），跑满 2 个发布周期再收口；或不动 |
| 2.4 | CouchDB `_replicator` 历史文档 id 前缀 `rssfed-` | 新实现不创建这类文档（`replicator.ts:49`），但升级清理只认当前前缀：改名后**旧版本遗留的 `rssfed-{uid}:w*` 常驻复制永远不被 purge**，继续占复制槽和 `_changes` 长轮询，抢按需复制的资源（`replicator.ts:278-280`） | 改成**双前缀**清理：保留旧前缀常量 + 新前缀，两者都删；`timeline-replication.test.ts` 覆盖 |
| 2.5 | Postgres 角色/库名 `rssfed` | 只改 compose 的 `POSTGRES_USER/DB`（`docker-compose.prod.yml:36,38`）不会重命名已存在卷里的角色/库；应用默认连接串仍指 `.../rssfed`（`db/index.ts:6` + `docker-compose.prod.yml:208,237` 兜底）→ **启动即连不上** | 元数据改名、不搬数据：`ALTER DATABASE rssfed RENAME TO fediloom;`（需先断开连接）+ `ALTER ROLE rssfed RENAME TO fediloom;`，同步 `DATABASE_URL`/`POSTGRES_*`，重启一次；或**保留旧名**（用户不可见，零成本） |
| 2.6 | compose project 名 `rssfed-prod` + 5 个具名卷 | 新 project = 新卷（`fediloom-prod_postgres-data` 等 5 个，`docker-compose.prod.yml:310-314`）：Postgres/CouchDB/Redis/上传目录/SeaweedFS **全部空库启动**；旧卷仍在磁盘但无人引用。这是唯一会触及**服务端权威数据**的项，`.doco-cd.yml:8-10` 与 `docs/docker-deployment.md:387` 都把它写成硬约束 | A. **不动（推荐）**——project 名不可见，收益为零；B. 停机 + 逐卷拷贝（`docker volume create` + 临时容器 `cp -a`，5 个卷、峰值 2× 磁盘），再同改 `docker-compose.prod.yml:23` 与 `.doco-cd.yml:30`（两侧必须一致，否则 doco-cd 认不出 stack） |
| 2.7 | GHCR 镜像路径 `ghcr.io/tiaod/rssfed/*` | 仓库改名后 CI 按 `github.repository` 推**新路径**（`build-images.yml:107-109`），而 prod compose 仍拉旧路径（`docker-compose.prod.yml:203,221,272`）→ 拉不到新镜像，部署停摆（不丢数据，但发布会自锁） | CI 与 compose 的镜像路径**必须同一提交**改；或保守做法：CI 一版双推（新旧 path 都打 tag），迁移完成再删旧；是否自动跟随见「未确认」 |
| 2.8 | API token 前缀 `rssfed_` | 旧 token **继续有效**（校验整串 SHA-256，与前缀无关）；新 token 前缀变 `fediloom_`，DB `prefix` 列会混两种前缀。无功能影响，只有观感 | 无需迁移；要统一就让用户重新生成 token（属于用户操作成本） |
| 2.9 | S3 桶名 / 对象 | 改桶名 = 新桶为空：头像、站点 logo、PWA 图标读不到（对象还在旧桶）；公开 URL 由 `STORAGE_S3_PUBLIC_DOMAIN` 决定（`storage.ts:170-176`），DB 里存的是 key，所以**换桶本身不需要改 DB** | **不动（推荐）**——桶名对外不可见；必须改则 `mc mirror` / `rclone copy` 旧桶→新桶 + 改 env |
| 2.10 | 宿主目录 `~/rssfed` + `RSSFED_*` 变量 | 改目录/变量 = doco-cd 读不到 env_file、bind mount 源变空目录；同类事故见 `docs/troubleshooting.md:538`（缺文件被建成空目录，502 持续 6h44m） | 纯部署操作：建新目录并按原权限（`.env.production` 640、私钥 600）复制，然后**同改** `deploy/doco-cd.yml`（`~` 路径、mount、git URL）与 `.doco-cd.yml`（`RSSFED_*`、`name`），重建 doco-cd 容器；GitHub 改名后 git 有重定向，但建议同步改 `deploy/doco-cd.yml:60-63` |
| 2.11 | MCP 客户端配置里的 server key（用户侧 JSON 的 `rssfed`） | **无影响**：这个 key 是客户端本地命名，服务端只认 URL 与 Bearer token（`McpSetupPanel.vue:136` 的示例；桥接方案见 `docs/archive/dsh-mcp-bridge.md:161-162`）。老配置照常工作 | 无需迁移；只改新生成的示例文案。严格说属 T0/T3，列在这里只为明确「它**不**需要迁移」 |

### T3 外部观感（可最后做，或不做）

出站 User-Agent（`parser.ts:309`、`images/fetch.ts:121`）、`diagnose-image-cache.ts:335` 的 UA、
CouchDB 代理 `vendor`/`version`（`couchdb.ts:89-90`——客户端只读 `doc_count` 判断库信息，
`useTimelineCloudInfo.ts:56-70` 不解析 version，**改它安全**）、MCP 配置示例的客户端 key、
GitHub issues 外链、`docs/archive` 与 `docs/notes`。

## 四、推荐执行顺序

**总原则：先改「别人看得见的名字」，再改「代码里的名字」，最后才考虑「存储里的名字」。**
三个阶段都能独立发布、独立回滚，不存在「改一半不能用」的中间态。

### 阶段 0：不发版就能完成的线上换牌（约 5 分钟）

运行中的实例的可见品牌几乎全来自 `site_settings`（见第一节），所以第一批改动连代码都不用碰：
后台「站点设置」里把下面几项填成新品牌，保存即生效（manifest 里带 `?v=` 版本号，图标 URL
会立刻换新；已安装的 PWA 要等系统下次刷新 manifest 才改名）。

| 字段 | 建议值 | 影响面 |
| --- | --- | --- |
| `siteTitle` | `FediLoom` / `织阅` | manifest `name`、`apple-mobile-web-app-title` |
| `pwaShortName` | `FediLoom`（≤12 字符最稳） | 主屏幕图标下的短名 |
| `description` | 可沿用「支持 ActivityPub 的 RSS 阅读器」 | manifest `description` |
| `primaryColor` | `#F2B84B`（暖金） | 主题色兜底 |
| `pwaThemeColor` | `#0B1026`（深空蓝） | 浏览器 UI / 状态栏着色 |
| `pwaBackgroundColor` | `#0B1026` | 启动画面底色（`maskable` / `apple-touch` 的不透明底） |
| `pwaIconUrl` / 图标上传 | 新方形图标（1024、不透明） | 四种规格由服务端按 `ICON_SPECS` 实时生成 |
| `logoUrl` | 新 logo（横版/SVG 均可） | 目前**只被后台表单展示**，前台模板没有消费点；但没填 `pwaIconUrl` 时它是图标的回退源（`manifest.ts` 的 `iconSourceSignature`） |

**设计师交付物只有两个落点**（不随配置走，必须发版）：

1. `packages/hono-server/src/pwa/render.ts:52-63` 的 `defaultIconSvg()`：内置兜底图标。
   现在是通用 RSS 弧线（不含 "rssfed" 字样，所以 grep 命中不到，最容易漏）。未上传任何图标时
   manifest 与 apple-touch 都用它 —— 换成 FediLoom 图标的内联 SVG，并保持
   「`maskable` 图形落在中心 80% 安全区、不透明底」的既有约定（见 `ICON_SPECS` 注释）。
2. `packages/nuxt-client/public/favicon.ico`：浏览器标签页图标。现在只有 1 个 32×32 条目，
   建议打 16/32/48 三档。

> 阶段 0 做完，改名的观感部分已完成大半，且完全可逆（字段改回去即可）。阶段 1 只是把
> 「空配置时的默认名」和写死的页面标题/文案一起换掉，让新部署开箱就是新品牌。

### 阶段 1：零风险品牌层（T0）

- **范围**：(a) 类 8 文件；`public/favicon.ico`；现行文档（`README.md`、`ARCHITECTURE.md`、
  `docs/docker-deployment.md`、`docs/troubleshooting.md`）；社区名统一为 FediLoom / 织阅。
  顺手修 `document.title` 不读 `siteTitle` 的缺口（`app.vue:58-61`，用
  `settings.siteTitle || DEFAULT_APP_NAME`，注意 SSR 首屏会用默认名）。
- **爆炸半径**：纯视觉与文档。已配置 `siteTitle` 的部署看起来不变；空配置部署默认名变 FediLoom，
  PWA 重装/更新后主屏幕名才会变。
- **验证**：`pnpm typecheck`（基线见文末，当前为 0 失败）+ `pnpm test`；浏览器看首页/登录页/
  页脚/欢迎通知；`curl /api/site-settings/manifest.webmanifest` 看 `name`。
- **回滚**：`git revert` 单提交；无数据影响。
- **改动量**：约 16 个文件（8 代码 + 7 文档 + 1 资产），2 轮 find/replace。

### 阶段 2：包名 / 仓库 / 镜像名（T1）

- **范围**：`@rssfed/*` → `@fediloom/*`（4 个 manifest/构建文件 + 3 个脚本注释）；
  仓库名与镜像路径（`.github/workflows/build-images.yml:107-109,119`、
  `docker-compose.prod.yml:203,221,272`、`Dockerfile:10-11`、`deploy/doco-cd.yml:60-63`）。
- **顺序约束**：CI 推送路径与 compose 拉取路径必须在**同一提交**；doco-cd 的 git URL 与
  deploy key 紧随其后（GitHub 改名有重定向，但不能依赖它）。
- **爆炸半径**：构建、CI、镜像拉取；**零用户数据**。
- **验证**：`pnpm install --frozen-lockfile`（lockfile 应**无 diff**）、`pnpm typecheck`、
  `pnpm test`；CI 构建 `ghcr.io/<新仓库>/{server,web,migrate}` 并在测试环境用
  `sha-<hash>` tag 部署一次（workflow:107-110 的不可变 tag 机制不变）。
- **回滚**：revert；旧 tag 镜像仍在 registry，CI 重推旧路径即可。
- **改动量**：约 10–12 个文件，3 轮 replace（`@rssfed/`、`tiaod/rssfed`、本地构建 tag 注释）。

**GitHub 仓库改名的操作顺序**（当前仓库是 `tiaod/rssfed`，`git remote -v` 已确认）：

1. 先发一版「镜像路径兼容」：CI 同时推 `ghcr.io/tiaod/rssfed/*` 与 `ghcr.io/tiaod/fediloom/*`
   （或按 `github.repository` 之外再加一条固定前缀的 tag 规则）。此时 compose 仍拉旧路径，
   彻底消除「仓库改名瞬间新镜像推到别的路径」的停摆窗口（GHCR 是否随仓库改名自动跟路径见第七节，未确认）。
2. 改 GitHub 仓库名（Settings → Rename）。网页与 `git clone`/`git fetch` 有 301 重定向，
   但**发布链路不能依赖重定向**：同步改本地 `git remote set-url`、`deploy/doco-cd.yml:60-63`
   的 `git@github.com:...`、`UserMenu.vue:62` 的 issues 外链。
3. 同一提交里把 compose 的镜像路径切到新路径（`docker-compose.prod.yml:203,221,272`）；
   此时 CI 里的 `github.repository` 已等于新名字，两边自然一致。
4. 验证：CI 绿 → doco-cd 轮询到新 `deploy/release.env` → `docker compose pull` 能拉到新路径 →
   容器起来。旧路径镜像**保留一个发布周期**再删（就是回滚用的）。
5. 可选：GitHub 上用旧名建一个空仓库占位，避免外部链接与镜像路径被第三方「继承」造成混淆。

### 阶段 3（可选）：数据身份迁移（T2）

拆三步，**能不做就不做**；一旦做，必须「先双认、后收口」两次发布，给回滚留窗口。

**3a 无持久化影响（一次部署窗口）**：内部头 `x-rssfed-user-id` → `x-fediloom-user-id`
（`mcp.ts:75,441`）、MCP `serverInfo.name`（`mcp.ts:78`）、token 前缀（`api-token.ts:16`）、
出站 UA、代理 vendor/version。爆炸半径：本实例客户端（MCP 客户端重连即可）；验证 `pnpm typecheck`
+ `pnpm test`（需同步改 `mcp.test.ts:79,88,95`、`useTimelineCloudInfo.test.ts:84`）；
回滚 revert。约 10 文件。

**3b 浏览器持久化**：PouchDB 前缀、localStorage 键、SW 缓存前缀。
推荐两条路：**（推荐）不动**；或「复制迁移」——启动时检测旧库存在则本地 `replicate` 到新库，
成功写新迁移标记、旧库进待删列表（下个版本删），失败回退旧库名；SW 过渡期删双前缀。
爆炸半径：每个用户一次本地数据搬迁（或全量重下）；验证需真浏览器覆盖「已有旧库的老用户」，
并同步改 `localDbName.test.ts`（26 处断言）。**无停机，但本地库删了只能重下**，回滚只能回代码。

**3c 服务端持久化（多数建议不做）**：
CouchDB 库名**本来不含品牌，不动**；`_replicator` 前缀改**双前缀清理**（`replicator.ts:41`，
覆盖 `timeline-replication.test.ts` 的 7 处断言）；Postgres 角色/库可选择 `ALTER ... RENAME`；
**Docker project/卷与 S3 桶明确不动**。爆炸半径：Postgres 改名需要断开连接/短停机；
Docker 卷迁移需要停机 + 5 卷拷贝（峰值 2× 磁盘）。验证：`pnpm typecheck` + `pnpm test`、
`/api/health`、CouchDB `_replicator` 无残留、登录 + 首屏同步走通。

### 明确建议不做

CouchDB 库名（本就不含品牌）、Docker project 名与具名卷、S3 桶名、Postgres 库/角色名。
这四项的收益只有「看着整齐」，成本却是停机、不可逆的卷迁移或用户重下。

## 五、改完之后的验收清单

改名是否成功不看 commit 数，看这几条（前半「名字对不对」，后半「身份有没有被顺手改掉」）：

```bash
# 1. 旧名字是否清干净。预期只剩「刻意保留」的白名单：
#    localDbName.ts / usePouchDb.ts（PouchDB 库名与 localStorage 键）、sw.js（若未做 3b）、
#    replicator.ts（若未做 3c 的双前缀）、docker-compose*.yml 与 .doco-cd.yml（若保留 project 名、
#    PG 角色/库）、docs/notes/ 与 docs/archive/（历史留档）、report/（不入库）
grep -rin rssfed --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.nuxt \
  --exclude-dir=.output --exclude-dir=dist --exclude-dir=coverage .

# 2. 机器可读的品牌面
curl -s /api/site-settings/manifest.webmanifest | jq '{name,short_name,theme_color,background_color,icons}'
curl -s /api/site-settings | jq '{siteTitle,description,logoUrl,primaryColor}'

# 3. 图标四种规格「声明 = 实际输出像素」（声明与输出不一致会被浏览器丢弃，见 ICON_SPECS 注释）
for s in 192 512 maskable-512 apple-touch-180; do
  curl -s "/api/site-settings/icon/$s.png" -o /tmp/icon-$s.png && file /tmp/icon-$s.png
done

# 4. MCP：server 名变新，工具名不变（仍是裸名 list_subscriptions 等）
curl -s https://<域名>/mcp -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  | jq '.result.serverInfo.name'

# 5. 联邦身份必须与改名前逐字一致（这是「品牌改名」与「域名迁移」的分界线）
curl -s "https://<域名>/.well-known/webfinger?resource=acct:<bot>@<域名>" | jq
curl -s "https://<域名>/users/<bot>" | jq '{id,preferredUsername}'
```

人工抽查：

- 浏览器标签页标题（`document.title` 现在接 `siteTitle` 了）、登录页页头、页脚版权、空列表标题、
  欢迎通知都是新名；
- 已安装 PWA 的主屏幕名与图标（卸载重装一次最快确认）；
- **本地同步未被重置**：DevTools → Application → IndexedDB，库名仍是 `rssfed-timeline-*`
  （若你选了「不动」）；新库不该凭空出现，也不该触发全量重下；
- Service Worker 只剩一个**新增**的缓存名（若做了过渡期双前缀清理，旧 `rssfed-*` 应已消失）；
- 生产日志无 5xx、`/api/health` 正常、CouchDB `_replicator` 无残留旧前缀任务（若做了 3c）。

CI 侧：`pnpm typecheck` + `pnpm test` 全绿；`pnpm install --frozen-lockfile` 不产生 lockfile diff。
**基线（2026-10-24 实测）**：`pnpm typecheck` 两包均通过；`pnpm test` 40 + 65 个测试文件、
405 + 642 个用例全过，无既有失败。改名前后对比这两组数字即可。

## 六、工作量估算

| 阶段 | 文件数 | find/replace 轮次 | 必须同步更新的测试 | 预估工时 | 停机 |
| --- | --- | --- | --- | --- | --- |
| 0 线上换牌 | 0（后台配置 + 2 个品牌资产文件） | 0 | 0 | ~10 min | 无 |
| 1 品牌显示 | ~16（8 代码 + 7 文档 + 1 资产） | 2 | 0 | 2–3 h | 无 |
| 2 包名/镜像 | ~10–12 | 3 | 0 | 2–4 h | 无 |
| 3a 内部标识 | ~10 | 1 | 2（`mcp.test.ts`、`useTimelineCloudInfo.test.ts`） | 2–3 h | 无 |
| 3b 浏览器持久化 | ~7 + 迁移分支 | 逐常量手改（不能批量） | 1（`localDbName.test.ts`，26 断言） | 1–2 人日（含老库/离线/多账号验证） | 无 |
| 3c 服务端持久化 | ~11 代码/配置 + 2 步运维 | 逐常量手改 | 1（`timeline-replication.test.ts`，7 断言） | 0.5–1 人日 + 迁移窗口 | 仅 PG/卷改名需要 |

- **只做阶段 0**：约 10 分钟，线上观感立刻换新，可先上线看效果再决定要不要动代码。
- **只做阶段 0+1+2**：0.5–1 人日，用户零感知风险，可立即发布。
- **做到 3a**：1–1.5 人日，对外标识全部统一。
- **全量 3**：3–5 人日（其中 3b 的真机验证占大头）。

**单个最大风险：compose project 名（2.6）。** 它决定 5 个具名卷的真实名字，一改就是新卷启动：
Postgres 与 CouchDB 的权威数据「看起来消失」，而 Docker 不支持改卷名/容器 labels
（`.doco-cd.yml:8-10` 已写明），只能新建卷 + 人工拷贝 + 停机，并且 stack 名与 compose `name`
必须两边一致，改错一侧会让自动部署停摆。相比之下 PouchDB 只是可重算的缓存
（`ARCHITECTURE.md:71-72`），最坏情况是重下。**所以：显示层随便改，部署与数据身份别动。**

## 七、未确认 / 边界

- **GHCR 包路径是否随 GitHub 仓库改名自动跟随**：未确认。本文按「不会自动跟随」做保守假设
  （CI 推新路径、compose 仍指旧路径即失败）；改名前应先做一次 dry-run 或查 GitHub 文档。
- **`/nodeinfo/*` 的 software 字段**：本仓库 `src/routes/` 下没有 nodeinfo 代码，推测由
  BotKit/Fedify 默认提供；是否含品牌名未确认（联邦可见面，建议改名后抽查一次 nodeinfo 响应）。
- **生产 `STORAGE_S3_PUBLIC_DOMAIN` 是否含桶名**：决定 DB 里已存的 `logoUrl`/`avatarUrl`
  是否需要在换桶时重写；未确认（本地 `.env.example` 不开公开域名，回退 `/api/files/*`）。
- **`pnpm test` 基线**：2026-10-24 实测 `pnpm typecheck` 通过（两包 Done），`pnpm test` 通过
  （hono-server 40 文件 / 405 用例，nuxt-client 65 文件 / 642 用例）。改名后应与这两组数字对比，
  避免把既有失败算到改名头上。
- 清单基于当前工作区（含未提交改动）的 grep 结果；`report/` 未入库（`.gitignore:21`），
  其 18 处不计入「仓库需改」范围，但其中硬编码的绝对路径在工作区目录改名后会失效。
- **本机工作区目录改名**（`/home/tiaod/workspace/rssfed` → `.../fediloom`）：对 git 与 pnpm 都基本
  无影响（workspace importers 按相对路径索引、lockfile 0 处仓库名），`git` 直接可用；若改完出现
  `node_modules/.bin` 里的绝对软链报 ENOENT，重跑一次 `pnpm install` 即可。`report/` 里硬编码的
  旧绝对路径会失效，按需重跑。
