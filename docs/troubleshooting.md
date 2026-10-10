# 踩坑记录

按现象组织，便于搜索。每条记录**现象 → 原因 → 解法**。机制与设计取舍见 [ARCHITECTURE.md](../ARCHITECTURE.md)、[offline-and-pwa.md](offline-and-pwa.md)。

## 构建与启动

### `node dist/index.js` 报 `ERR_MODULE_NOT_FOUND`

- **现象**：tsc 构建成功，node 跑产物时找不到 `./app` 等相对模块。
- **原因**：`moduleResolution: bundler` 下相对导入不带扩展名，tsc 原样输出，Node ESM 却要求显式扩展名。
- **解法**：改用 esbuild 打包（`build:bundle`）内联本地源码、第三方依赖保持 external；镜像与 CI 都走这条。

### 容器里跑临时脚本报 `ERR_MODULE_NOT_FOUND`

- **现象**：`docker compose exec server node /tmp/check.mjs` 找不到 `@aws-sdk/client-s3` 等依赖。
- **原因**：ESM 从**脚本所在位置**向上找 `node_modules`，`/tmp` 不在 `/app` 之下。
- **解法**：把脚本放进应用目录，如 `docker compose cp check.mjs server:/app/packages/hono-server/`；或用 `exec -w /app/packages/hono-server`。

## 配置与环境变量

### server 报 `You are not a server admin`，CouchDB 代理认证配置失败

- **现象**：容器日志出现该错误，proxy auth 没配上。
- **原因**：`COUCHDB_USER` 没设或只在 `env_file` 里，而 `couchdb/client.ts` 的默认值是**空字符串**（不是 `admin`），Basic 认证变成 `:password`。
- **解法**：编排里给 server 显式传 `COUCHDB_USER: ${COUCHDB_USER:-admin}`，与 CouchDB 容器同用户名。

### 登录后看不到任何订阅内容，`/api/couchdb/proxy/*` 全部 401

- **现象**：能登录，但时间线与订阅列表空白；`/api/couchdb/proxy/<库名>/...` 全 401，响应体 `{"error":"unauthorized","reason":"You are not authorized to access this db."}` —— 这是 **CouchDB** 的措辞；Hono 拦下的是 `{"error":"unauthorized"}`（那才是会话 cookie 失效）。
- **原因**：CouchDB **只在启动时**读 `chttpd/authentication_handlers`（启动后改 config 无效，3.5 已移除 `POST /_restart`），而 server 是「连上 CouchDB 才写配置」，`proxy_authentication_handler` 因此从未挂载：带 `X-Auth-CouchDB-*` 的请求全被当匿名用户、被库级 `_security` 拒绝，同步整体失败。
- **排查**：进 CouchDB 容器看运行时认证链——
  ```bash
  docker exec <couchdb 容器> curl -s http://localhost:5984/_session
  # 正常：{"info":{"authentication_handlers":["cookie","proxy","default"]}}
  # 故障：{"info":{"authentication_handlers":["cookie","default"]}}   ← 缺 proxy
  ```
  `_node/_local/_config/chttpd/authentication_handlers` 里写着 proxy 也算不了数，那只是配置而非运行时状态。
- **解法**：把配置固化到 CouchDB 启动时会读的 ini —— [deploy/couchdb-proxy-auth.ini](../deploy/couchdb-proxy-auth.ini)，两个 compose 已挂到 `/opt/couchdb/etc/local.d/00-proxy-auth.ini`。两个坑：**不能加 `:ro`**（只读会让 entrypoint 的 chown 失败，容器无日志直接 exit 1）；**前缀必须 `00-`**（否则 `COUCHDB_PROXY_SECRET` 会被写进 local.d 里最后加载的 `docker.ini`，即受版本控制的文件）。跑歪的实例重建即可：`docker compose --env-file .env.production -f docker-compose.prod.yml up -d couchdb server`（重建 couchdb 会丢掉容器内的 `docker.ini`，两个要一起重建）。启动时自动校验（[couchdb/proxy-auth.ts](../packages/hono-server/src/couchdb/proxy-auth.ts)），未挂载会在日志里给出修复动作。
- **注意**：`chttpd_auth/secret` 与 `proxy_use_secret` 每次请求读取，仍由 server 启动时写入，不进 ini、不入版本控制。

### 改了 `.env.production` 却不生效

- **原因**：`env_file` 的变量在**容器创建时**注入，`docker compose restart` 不会重新读取。
- **解法**：用 `up -d --no-build <service>` 重建容器。

### 未知的 `STORAGE_DRIVER` 静默走了别的后端

- **现象**：驱动名拼错，服务照常启动但头像上传失败。
- **原因**：分派逻辑只判断已知值，其余落到默认分支。
- **解法**：`createStorageFromEnv()` 现在对未知取值**直接抛错**，配置错误在启动时暴露。

### 示例配置与真实环境脱节

- **现象**：`.env.example` 写的是 Garage（`localhost:3900` / `region=garage`），实际 dev 用的是 SeaweedFS（`8333` / `us-east-1`），照示例配连不上。
- **教训**：示例文件是文档，改环境时容易忘记同步；已把示例对齐到实际在用的服务。

### 控制台刷 `GET /api/couchdb/proxy/` 404（数量≈订阅数+1）

- **现象**：每个订阅同步时都出现一条 `GET /api/couchdb/proxy/` 404，功能正常，没有别的报错。
- **原因**：这是 **PouchDB 建立复制前对远端库的 uuid 探测**，不是脏数据 —— 探测打的是「去掉库名段后的路径」，所以所有订阅都是同一条 404；拿不到 uuid 时 PouchDB 回退用远端库 URL 当复制 id，同步不受影响。
- **快速验证**（库名从 `GET /api/couchdb/sync-targets` 拿，或按库名规律从 `_all_dbs` 找）：
  ```js
  const PouchDB = require('pouchdb')
  const db = new PouchDB('http://localhost:3001/api/couchdb/proxy/feed_xxxxxxxxxxxxxxxxxxxxxxxx')
  await db.id() // 实际发出 GET .../feed_xxx/ 和 GET .../proxy/（后者就是那条 404）
  ```
- **解法**：后端对探测路径返回 CouchDB 风格的根信息（`couchRootInfo`）：[routes/couchdb.ts](../packages/hono-server/src/routes/couchdb.ts)，回归用例 [couchdb-proxy-route.test.ts](../packages/hono-server/src/__tests__/couchdb-proxy-route.test.ts)。**响应里必须不带 `uuid`**：带上后 `api.id` 就改用 `uuid + 库名` 当复制 id，既有 checkpoint 全部失效、每个订阅白跑一次全量重同步（第一版带 uuid 时每个 feed 都多出一条 `_local/...` 404）。
- **别从这条 404 推断「有脏订阅」**：代理不再按业务 id 拼地址，空 feedId 的订阅在前后端都会被过滤掉（[usePouchDb.ts](../packages/nuxt-client/app/composables/usePouchDb.ts) 的 `isValidDbId`、[services/feeds.ts](../packages/hono-server/src/services/feeds.ts) 的 `listSubscriptionsForUser`），不会进入复制队列。

### 同步时 `.../proxy/<库名>/_local/<id>` 返回 404

- **现象**：`GET /api/couchdb/proxy/<库名>/_local/xxxx==` 404，响应体 `{"error":"not_found","reason":"missing"}`。
- **原因**：PouchDB 复制前的 **checkpoint 读取**：checkpoint 尚不存在时 CouchDB 就返回 404，PouchDB 据此从头复制、结束时 PUT 写入。**属于正常链路**，只有首次会 404，之后同一复制 id 会命中并返回 200。
- **排查**（路径里的库名是随机生成的，不是 `feed_<feedId>`；feed 库名在 `feeds.couch_db_name` 列，代理只下发用户库名）：
  ```bash
  docker exec hono-server-postgres-1 psql -U rssfed -d rssfed -c \
    "select couch_db_name from feeds where id='<feedId>';"
  curl -s -u admin:admin "http://localhost:5984/<couch_db_name>/_local_docs?include_docs=true"
  ```
  复制过就能看到 `_local/<replicationId>` 文档（`_rev` 递增、带 `last_seq`）。
- **什么时候才是真问题**：**每次**同步都 404 且库里始终没有 checkpoint —— 说明 PUT 失败（权限或代理问题），每个订阅会反复全量复制。
- **复制 id 一变就重同步**：id 由本地库名 + 远端库 URL 决定，改过 `COUCHDB_PROXY_SECRET`、库名重建、代理地址格式调整都会让 checkpoint 作废。

### 同步成片 `400 invalid_database`：前端还是旧版本

- **现象**：升级后端后，同步请求全部 `400 {"error":"invalid_database","reason":"... 不是本服务可代理的库名", ...}`。
- **原因**：代理只接受真实库名，旧版前端仍按业务 id 拼地址（`/api/couchdb/proxy/feed/<feedId>`）；旧页面还跑着旧 JS（新版 SW 先待命，等用户点更新才激活，见 [offline-and-pwa.md](offline-and-pwa.md)）。
- **解法**：刷新页面即可，错误响应里的 `hint` 也写了这条。

### 时间线一直空、提示条停在「已同步 0 条」：复制器还没把内容搬过来

- **现象**：登录正常、订阅列表有内容、`GET /api/couchdb/sync-targets` 也下发了 `user-timeline_xxx`，但时间线始终空白（或只出现几条），`POST /api/timeline/refresh?wait=1` 返回 `{"accepted":true,"completed":false}`。
- **原因**：真正的搬运交给 **CouchDB 复制器**（每个 (用户 × 订阅源) 一条常驻复制），我们那一轮只对齐拓扑（建/删任务）与剪枝，很快就返回；`wait=1` 的判据是"派生库安静"（`minWaitMs` 4s + 连续 5 轮没有新条目），所以它可能在复制器刚拉起、首批数据还没到端时就报 `completed:true`。附件也不再重压，是源库成品原样搬。
- **排查**：
  ```bash
  docker logs <server 容器> | grep '\[Timeline\]'                     # 一行「源=… 新建复制=… 删除复制=… 剪枝=…」
  curl -s -u admin:admin "http://localhost:5984/_scheduler/docs/_replicator" | head -c 2000
  curl -s -u admin:admin "http://localhost:5984/<user-timeline 库名>" | grep doc_count
  ```
  调度器里那条任务应当是 `running`（`crashing` / `error` 会带上原因）。任务清单本身就是「哪些源在搬」的真相；库里的 `_local/state` 只存版本标记与设置快照，**不再有每源游标**。
- **解法**：等它搬（Steady state 下复制器自己长轮询，不需要我们催）。整库搬不动时再 `POST /api/timeline/rebuild`：它是**换一个空聚合库重搬**（换库才会清掉复制 checkpoint），用户自己写的订阅/已读收藏会跟着搬过去，客户端会丢掉本地缓存重新全量拉一遍。

### `POST /api/timeline/refresh` 直接 500 且一条复制任务都没有：CouchDB 的 JS 查询服务卡死了

- **现象**：客户端一条内容都同步不到（订阅列表还在，因为那是客户端推上去的），`POST /api/timeline/refresh?wait=1` 返回 500；`_replicator` 里**一条**本服务的任务都没有，用户库里的 `_design/timeline-maintain` 与 `_local/state` 也不存在。
- **原因**：聚合这条链路处处要用 CouchDB 的 **JS 查询服务**（写设计文档要编译 JS、剪枝查 `by_published_at` 视图、复制过滤器在源端执行）。`couch_proc_manager` 一旦卡死，这些操作全部超时：日志里是
  `rexi_server: ... mfa: fabric_rpc:update_docs/3 exit:{timeout,{gen_server,call,[couch_proc_manager,{get_proc,{client,undefined,undefined,<<"javascript">>,...}},5000]}}`，
  请求侧是 `POST /<库名> 500`（写设计文档）或 `GET .../_view/... timeout`。
  于是 `ensureTimelineDesignDoc` 装不上设计文档（旧实现还把这次失败吞掉并缓存成"已就位"），剪枝那步查一个不存在的视图抛 404 —— 整轮 reconcile 中断，**复制任务一条都不建**，客户端自然拉不到东西。
- **怎么确认**（dev 实测）：
  ```bash
  curl -s -u admin:admin "http://localhost:5984/_node/_local/_system" | head -c 200   # beam 本身健康
  curl -s -u admin:admin "http://localhost:5984/<任意 feed 库>/_design/main/_view/entries-by-date?limit=1"  # {"error":"timeout"} = JS 查询服务卡死
  curl -s -u admin:admin "http://localhost:5984/<库名>/_design/timeline-maintain"     # 404 = 没装上
  docker logs <couchdb 容器> --tail 2000 2>&1 | grep couch_proc_manager
  ```
- **解法**：重启 couchdb（`docker restart <couchdb 容器>`；不能只 `up -d` 别的服务）。**根因通常是 fd 不够**：容器默认 `nofile=1024`，实测 beam 在几十条复制下就占到 900+，调度器里开始报 `{conn_failed,{error,emfile}}` / `sel_conn_closed` / `req_timedout`，`open_port` 起 couchjs 失败后 `couch_proc_manager` 就永久卡住了。两个 compose 的 couchdb 服务已加 `ulimits.nofile: 65536`（配合 `deploy/couchdb-replicator.ini` 的 `max_dbs_open`），改完要**重建**容器（`docker compose up -d couchdb`）才生效，`docker restart` 不会应用新的 ulimit。重启后服务端会自己补装设计文档与过滤器并建任务（`ensure*` 失败不再进缓存），不需要手工修库。

### 图片接口返回 502 `image_unavailable`

- **现象**：`GET /api/images/cached?url=…&w=…&q=…` 返回 502，响应体 `{"error":"image_unavailable","reason":…}`。
- **原因**：看 `reason`（取值见 `images/fetch.ts` 的 `ImageFailReason`）——`invalid-url`（URL 不合法，或**公网接口**拿到内网/回环地址被 `isPrivateHost` 挡掉，防 SSRF）、`http-status`（403 防盗链 / 404 / 5xx）、`content-type`（返回的不是图片）、`too-large`（源图超过 `maxSourceImageBytes`）、`timeout` / `network`（连不上或读取超时）、`redirect-limit`（跳转超过 3 次）、`decode`（sharp 解不出来）。这条链路只在**抓取**时跑：失败只记数不阻塞（worker 打的一行 `[EntryImages] … 原因[…]`），条目照常入库、只是没有附件，聚合不会再重试。
- **注意**：`invalid-url` 有两种来源（URL 本身非法 vs. 内网地址被拒），响应里不区分；本地 dev 用内网图床调试时要在调用侧显式 `allowPrivateHosts`（见 `images/cache.ts` 的依赖注入），抓取路径与公网接口的默认值不同。
- **解法**：先直接 `curl -I <源图 URL>` 确认可达；大图调大 `MAX_SOURCE_IMAGE_BYTES`，或在该 feed 的图片策略里单独调（订阅源管理页 / `feeds` 表的图片列）。同一张图 + 同一组参数只会失败一次，不会反复重试拖慢抓取；已经入库的条目要等下次抓到新条目或按源重抓才会带上图。

### 同步全报 `Database does not exist`：库名还登记着，库却没了

- **现象**：订阅列表正常、`GET /api/couchdb/sync-targets` 也下发库名，但同步返回 CouchDB 的 `{"error":"not_found","reason":"Database does not exist."}`。
- **原因**：库名解析走快路径：已登记的库名直接返回、不再校验库是否还在（[client.ts](../packages/hono-server/src/couchdb/client.ts) 的 `resolveDatabase`），手工删库、数据卷丢失**不会自动重建**。
- **解法**：把对应行的库名置空，下次寻址/抓取会重新建库：
  ```bash
  docker exec hono-server-postgres-1 psql -U rssfed -d rssfed -c \
    "update feeds set couch_db_name = null where id='<feedId>';"
  ```
  feed / bot 库同理（`feeds` / `bots` 表的 `couch_db_name`）；**用户库**置空 `user.timeline_db_name` 后下次聚合会重建。重建出来的是**新库**，旧数据不会回来，本地 PouchDB 也会因远端库 URL 变化全量重同步一次（用户状态文档要从客户端再推上来，见下面那条）。库级 `_security` 只在建库时设置一次，改坏了同样用置空库名的方式重建。

### 重建之后内容回来了，但浏览器里看不见

- **现象**：`POST /api/timeline/rebuild`（或设置页的「重建时间线」）之后，服务端新库里有条目，但页面上的时间线还是空的（或比预期的少）。
- **原因**：重建是**换一个空聚合库**（复制是变更投递不是投影，就地清空搬不回来），于是 ① 库名变了、客户端缓存的寻址信息还指着被删掉的旧库；② 本地为「被剪掉的条目」留着删除记录（tombstone，修订号更高），重建搬回来的内容在本地会被判成冲突、看不见。
- **现状**：设置页的「重建时间线」会在请求成功后**等库名变过来**（最多 60s）再丢掉本地缓存重新全量拉一遍（[useTimelineSettings.ts](../packages/nuxt-client/app/composables/useTimelineSettings.ts)）。手工 `curl` 触发重建时没有这一步，浏览器要手动重开页面或清掉该站点的 IndexedDB。
- **别手工 `DELETE /<用户库>`**：那会连用户写的订阅/已读收藏一起删。要收缩数据用窗口设置（剪枝），要整体重来用重建接口。

### 升级后每个账号都"重建"了一次：v1 → v2 换库重搬

- **现象**：升级到复制器版之后，日志出现一行 `[Timeline] 用户=… 换库重搬：user-timeline_old → user-timeline_new（搬走用户状态 N 条，作废复制任务 M 条）`，每个已有账号一次，用户库名变了。
- **原因**：v1 的聚合库是**我们自己按窗口写进去的**（文档带我们的修订谱系），复制器按源库谱系落库会在同一个 `_id` 上撞出两条互不相干的修订 → 冲突；而"就地清空 + 重建任务"搬不回来（目标端删过的 rev 复制器不会再送）。所以 v1 → v2 走的是**换库重搬**：另建空库、把用户写的状态文档搬过去、旧库删掉，复制器从 0 扫源库。
- **注意**：这是**一次性**的（新库的状态文档写 `version: 2`），代价是每个账号的窗口内容重搬一遍、客户端重新全量拉一次；内容与订阅/已读收藏都不丢。旧库名变新库名后，客户端若还指着旧库，参照上一条处理。

### 某个订阅源一直不搬东西（复制任务 crashing / error）

- **现象**：`GET /_scheduler/docs/_replicator` 里某条任务 `state` 是 `crashing` / `error`，或 `_replicator` 文档在但目标库里始终没有该源的内容。
- **原因**（按出现频率）：
  1. **源/目标写的是裸库名**：复制器把它当远端 URL 解析，报 `replication_auth_error`（我们写的是带凭据的 URL，见 [replicator.ts](../packages/hono-server/src/couchdb/replicator.ts)）；
  2. 源库设计文档里没有 `filters.timeline`（新装的过滤器没生效，或库是手工建的）；
  3. **过滤器的 `query_params` 里出现了叫 `since` 的参数**：它与 CouchDB 自己的 `since` 撞名，过滤器读到的是序号字符串，窗口会静默失效（可能反而多搬）；
  4. 目标库被手工删了 / `_security` 改坏 → 任务反复重试。
- **解法**：先看调度器给的 `error` 原文；1、2、4 都可以通过"让代码重新对齐"恢复 —— 退订再订阅该源（删任务 + 删该源条目 + 删 FeedDoc 副本），或直接 `POST /api/timeline/rebuild`（换库重搬）。任务文档**不要手工改**：改参数等于换复制哈希，会触发一次全量重扫。

## 反向代理与网络

### https 页面上附件地址是 `http://`，图片被浏览器拦截

- **现象**：头像上传成功，`avatarUrl` 返回 `http://<域名>/api/files/...`。
- **原因**：`avatar.ts` 用 `new URL(c.req.url).origin` 拼 URL，反代之后 Node 适配器拿到的协议仍是 http。
- **解法**：优先取配置的对外地址（`BOTS_BASE_URL` / `BETTER_AUTH_URL`），都没配才回退到请求 origin。

### 只转 `/api/*` 会让联邦功能整体 404

- **原因**：Hono 除 `/api/*` 外，还用 `app.all("*")` 兜底承载 ActivityPub 端点。
- **解法**：反代必须同时转发 `/mcp`、`/mcp/*`、`/.well-known/*`、`/nodeinfo/*`、`/ap/*`、`/@*`（规则见 [deploy/Caddyfile](../deploy/Caddyfile)）。`/users/*`、`/inbox` 是 Fedify 默认路由与共享 inbox，当前未启用、实测 404，留着只为将来启用时不至于又漏。`/mcp` 不能做 301/307，否则 MCP 客户端跟随跳转会丢掉 `Authorization` 头。

### webfinger 正常但 actor 取不到：反代漏放行 `/ap/*`

- **现象**：Mastodon 里能搜到 bot 账号，但账号加载不出来、无法关注、收不到投递；站点首页与 `/api/*` 一切正常，极易误判成联邦代码有问题。
- **原因**：BotKit 的 actor 真实路径是 **`/ap/actor/{username}`**，而反代 matcher 放行的是**后端并不存在的 `/users/*`**（实测 404）。webfinger 走已放行的 `/.well-known/*`，照常返回 200 并给出 `/ap/actor/...` 链接，外部实例回来取时才落到 Nuxt 上 404。
- **解法**：反代 matcher 必须包含 `/ap/*`（以及 profile 页的 `/@*`），改完 `caddy reload`，用这条确认：
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' \
    https://<域名>/ap/actor/<bot名>     # 必须 200；返回形如 {"statusCode":404,...} 的 JSON 就是漏了
  ```
- **记录**：上线验收实测踩到，详见 [cloud-deployment-todo.md](cloud-deployment-todo.md)。

### 页面文字正常但图标整片空白：`/api/*` 抢走了 Nuxt 的图标接口

- **现象**：页面文字都在，但所有 lucide 图标空白；控制台里 `/api/_nuxt_icon/lucide.json?icons=...` 返回 404 `404 Not Found`（`content-type: text/plain`、带 `access-control-allow-credentials`，是 Hono 的 404 而不是 Nuxt 的）。
- **原因**：`@nuxt/icon` 的图标 API 挂在 Nitro 上（**`/api/_nuxt_icon/:collection`**，本项目唯一一条 `/api` 前缀的 Nitro 路由），反代的 `path /api/*` 把它一并甩给 Hono → 后端没有该路由返回 404；SSR 只输出 `<span class="iconify i-lucide:xxx">`，图标数据由客户端另取，取不到就整片空白。
- **解法**：在 `@backend` 那条 `reverse_proxy` **之前**放行（顺序不能反，Caddy 同指令按书写顺序匹配）：
  ```
  @nuxt_icon path /api/_nuxt_icon /api/_nuxt_icon/*
  reverse_proxy @nuxt_icon web:3000
  ```
  改完 `caddy reload`，用 `curl -s -o /dev/null -w '%{http_code}\n' 'https://<域名>/api/_nuxt_icon/lucide.json?icons=refresh-cw'` 验证：返回 200 且是 `application/json` 才算修好；只改前端重新构建没用。
- **另**：前端已开 `icon.clientBundle`（`nuxt.config.ts`），图标数据编译期内联进 bundle，客户端不再请求这个接口；上面的放行规则仍建议保留，将来有没进 bundle 的图标名时还会回退到它。

### 两个「创建机器人」按钮的图标一直不显示：图标名在 lucide 里不存在

- **现象**：[bots/index.vue](../packages/nuxt-client/app/pages/bots/index.vue)、[bots/explore.vue](../packages/nuxt-client/app/pages/bots/explore.vue) 的按钮图标空白，与网络、反代、离线状态都无关。
- **原因**：写的是 `i-lucide-bot-plus`，而 lucide 里只有 `bot` / `bot-message-square` / `bot-off`，**没有 `bot-plus`**。开了 `clientBundle` 后这类错误会让构建直接失败，反而更容易发现。
- **解法**：换成集合里存在的图标（本次改为 `i-lucide-plus`）；全量校验脚本见下一条。

### 图标名全量校验（改了图标或升级图标集后跑一次）

```bash
node - <<'JS'
const fs=require('fs'),path=require('path')
const cols=fs.readdirSync('node_modules/@iconify-json')
const data=Object.fromEntries(cols.map(c=>[c,JSON.parse(fs.readFileSync(`node_modules/@iconify-json/${c}/icons.json`,'utf8'))]))
const RE=new RegExp(`i-(${cols.join('|')})-([a-z0-9-]+)`,'g')
const walk=(d,acc=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,acc):/\.(vue|ts|js|mjs)$/.test(e.name)&&acc.push(p)}return acc}
for(const f of walk('packages/nuxt-client/app'))
  for(const m of fs.readFileSync(f,'utf8').matchAll(RE))
    if(!(m[2] in data[m[1]].icons)&&!(m[2] in (data[m[1]].aliases||{})))console.log(`无效图标 ${m[0]} → ${f}`)
JS
```

## 前端交互

### 条目弹窗里的正文无法用鼠标选中

- **现象**：弹窗里用鼠标拖过正文没有任何选区（`document.getSelection()` 一直是空），标题/按钮照常能点。
- **原因**：**拖选是从 `mousedown` 开始的**，而这条链路上有两处第三方默认行为在 `pointerdown` 上 `preventDefault()` —— 一旦被取消，浏览器就不再补发 `mousedown`：
  1. `scrollable` 的 `UModal`（居中弹窗，以及全屏但不固定顶/底栏）把内容**嵌在遮罩层里面**，reka-ui 给遮罩层挂了 `pointerdown` + `.left.prevent`，事件从正文冒泡上去照样被取消；
  2. 全屏档的 Swiper 默认 `simulateTouch`，把鼠标拖动也当划卡手势，同样在 `pointerdown` 上取消默认行为。
- **排查手法**：弹窗里执行 `document.addEventListener('pointerdown', e => console.log(e.defaultPrevented, e.target))`，打印 `true` 即命中本条。
- **解法**：见 `EntryDetailModal.vue` 的 `stopPointerDownPropagation`（在正文层掐断冒泡）与 Swiper 的 `:simulate-touch="false"`（桌面翻页走浮钮与 ←/→ 键，触屏滑动不受影响）。

### 同步成功后，同步弹层里还挂着几行「已同步 0%」

- **现象**：左下角同步指示器的悬停弹层里，标题已经是「同步成功」，明细里却还留着一串上一轮的「已同步 0%」；长同步里会越攒越多（每撞一次 key 多留一行），刷新页面才干净。
- **原因**：[SyncStatusIndicator.vue](../packages/nuxt-client/app/components/SyncStatusIndicator.vue) 的明细行 `v-for` 原先拿**行文本**当 `:key`，而文本会重复 —— 并发上限是 2，两个源都还没报进度时两行都是「已同步 0%」。重复 key 会让 Vue 的 keyed diff 把两个旧节点解析到同一个新节点上，先被解析的那个节点从此没人引用，留在 DOM 里再也不会被清理（开发模式只在控制台打一条 `Duplicate keys found during update`）。
- **解法**：明细行按位置取 key（`v-for="(line, i) in details"` + `:key="i"`）—— 这些行都是纯文本、没有身份。回归用例：`app/__tests__/components/SyncStatusIndicator.test.ts` 的「明细行会重复时：重渲染不留孤儿节点」。

## 离线与 Service Worker

### 断网后页面完全打不开（连壳都没有）

- **现象**：断网后访问站点是浏览器的「无法访问此网站」，不是应用内的离线提示。
- **原因**：`public/sw.js` 没注册或注册失败。**开发环境故意不注册**（`import.meta.dev` 短路，否则缓存优先会挡住 HMR），要看离线效果必须跑生产构建：`pnpm --filter @rssfed/nuxt-client build && node packages/nuxt-client/.output/server/index.mjs`。
- **排查**：DevTools → Application → Service Workers，应看到 `/sw.js` 处于 activated；Cache Storage 里应有 `rssfed-<构建号>` 且条目数 ≈ 60。另确认 `/sw.js` 与 `/sw-manifest.json` 能直接打开（反代别拦这两条路径）。
- **注意**：SW 只在安全上下文生效（HTTPS 或 localhost）。**前面若套了 CDN，要给 `/sw.js` 禁用缓存**，否则更新永远下不来。

### 部署了新版本，页面还是旧的

- **原因与解法**：SW 更新后不会立刻接管，页面弹「有新版本可用」，点刷新才切换 —— 刻意不自动 `skipWaiting`，否则新版一激活就清旧缓存、让还在用旧页面的标签页白屏（见 [offline-and-pwa.md](offline-and-pwa.md)）。
- 提示一直不出现，多半是 `/sw.js` 被中间层缓存了（见上一条）。

### 离线打开某个页面，看到的是「当前处于离线状态」

- **说明**：该路径之前没访问过，SW 没有同路径 HTML，回退到预渲染的离线外壳 `/offline`（回退链见 [offline-and-pwa.md](offline-and-pwa.md)）；客户端接管后一般会按地址栏 URL 渲染真实页面，数据还没同步到本机就停在外壳上。
- 想让某个入口离线必达，在线时至少访问一次即可（HTML 会被缓存）。

### 离线时数据是空的

- **数据不在 Service Worker 里**：条目、订阅、已读/收藏都在浏览器 PouchDB（IndexedDB）。新设备/新浏览器首次必须联网同步一次，之后才有离线内容；SW 只负责让页面能打开。
- 清过浏览器站点数据、或换过浏览器配置，都会丢掉本地库，需要重新联网同步。

### 同一浏览器换账号后，看到（并写进了）上一个账号的数据

- **现象**：A 登出、B 登录后，B 的时间线/订阅里出现 A 的订阅或已读状态；更麻烦的是 **B 的服务端用户库被写入了 A 的文档**。
- **原因**：旧版本本地 PouchDB 用固定库名（`rssfed-entries` / `rssfed-user-state`），而用户库是**双向**同步的，装着 A 数据的本地库会把文档推到 B 的远端库；增量同步记录（localStorage 的 `rssfed-synced-feeds`）也是全局 key，会让 B 整段跳过。
- **解法**：本地库名与同步记录 key 都带上账号 id（[utils/localDbName.ts](../packages/nuxt-client/app/utils/localDbName.ts)），换账号即换一套本地库；会话未就绪或未登录落到 `guest`。启动清理**删除**旧固定库名而非搬进新库 —— 旧库混着多个账号的数据，搬进去会把上个账号的数据固化后再推上远端。
- **已经被写脏的远端库**：查该账号用户库里的 `subscription:` 文档（`GET /api/couchdb/proxy/<库名>/_all_docs?startkey="subscription:"&endkey="subscription:\uffff"&include_docs=true`，库名从 `GET /api/couchdb/sync-targets` 拿），删掉不属于该账号的文档；本地侧换了库名会重新全量同步一次。

### 升级到单库方案后，旧的 user-state 库怎么处理

- **背景**：用户状态与聚合条目曾是两个库（`user-state_<随机>` + `user-timeline_<随机>`）。合并成单库后服务端只创建/下发一个库（`user.timeline_db_name`），`user.couch_db_name` 列与 `user-state_*` 库全部废弃。
- **升级动作**：先搬状态再切流量，用 [scripts/merge-user-state-into-timeline.ts](../packages/hono-server/scripts/merge-user-state-into-timeline.ts)。**搬运必须带原 `_rev`**（`new_edits: false`）：客户端本地那份状态文档的 rev 与远端一致，才不会把整份状态重新推一遍。脚本默认 dry-run、可反复执行（幂等），`--apply` 真搬、`--delete-source` 顺手删老库：
  ```bash
  docker compose --env-file .env.production -f docker-compose.prod.yml pull
  # 切 server/web 之前先搬（脚本用的是新镜像里的新代码，会把用户库建出来）
  docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate \
    pnpm exec tsx scripts/merge-user-state-into-timeline.ts            # 先看要搬什么
  docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate \
    pnpm exec tsx scripts/merge-user-state-into-timeline.ts --apply    # 真搬
  docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build
  ```
- **别急着删老库**：回滚镜像时旧代码读的还是 `user-state_*`，删早了就没得回滚。确认新架构稳定后再 `--apply --delete-source`（或手工 `DELETE /user-state_xxx`）。
- **不搬会怎样**：客户端升级时 v5 清理标记会删掉本地 `rssfed-user-state-<uid>`，服务端又只认用户库 —— 该用户**永久失去订阅关系与已读/收藏**（订阅不在 PostgreSQL 里，重建不出来；条目可以重新聚合）。
- **注意**：代理的库名前缀白名单里已不含 `user-state_`，历史库名经代理访问会直接 400 `invalid_database`。

## PWA 与安装到手机

### 手机上「添加到主屏幕」后图标是网页截图、打开还带地址栏

- **现象**：iOS 加完主屏幕后图标是页面缩略图，点开仍是带 Safari 地址栏的普通网页。
- **原因**：`<link rel="manifest">` 没被读到（404 或路径跨域），iOS 退化成「页面截图当图标 + 普通浏览器窗口打开」（为什么必须静态同源见 [offline-and-pwa.md](offline-and-pwa.md)）。
- **排查**（**必须用站点自身的同源地址**）：

  ```bash
  curl -sI https://你的域名/api/site-settings/manifest.webmanifest   # 期望 200 application/manifest+json
  curl -s  https://你的域名/api/site-settings/manifest.webmanifest   # 看 name / icons 是否来自站点配置
  curl -sI https://你的域名/api/site-settings/icon/512.png           # 期望 200 image/png
  ```

- **反代**：三条路径都在 `/api/site-settings` 下，落在既有 `/api/*` 规则内；若把 manifest 改挂到域名根下（`/manifest.webmanifest`），必须同步加转发，否则会落到 Nuxt 上 404。
- **开发环境**：前后端分端口（3000 / 3001），靠 `nuxt.config.ts` 的 `nitro.routeRules` 把 `/api/site-settings/**` 代理到后端。⚠️ 规则**必须保持精确前缀**：写成 `/api/**` 会连带抢走 `/api/_nuxt_icon/*`，导致图标整片空白（见「反向代理与网络」那条）。

### 图标装上后显示异常，或干脆装不上

- **尺寸不符是最常见原因**：manifest 声明 `512x512` 而实际输出别的像素时，Chrome **静默丢弃**该图标，表现为「manifest 看着完全正确，但安装入口不出现」。核对实际像素：

  ```bash
  curl -s https://你的域名/api/site-settings/icon/512.png -o /tmp/i.png && file /tmp/i.png
  ```

- **Android 图标边缘被裁**：maskable 不能拿普通方图顶替 —— 用 `/api/site-settings/icon/maskable-512.png`。
- **iOS 图标发黑**：iOS 把透明区域填黑，apple-touch 图标必须不透明 —— 用 `/api/site-settings/icon/apple-touch-180.png`。
- **改了配置但手机上还是旧图标**：已安装的 PWA 会缓存图标，需要先移除再重新「添加到主屏幕」。

### 改了站点设置，manifest 没更新

- manifest 响应是 `Cache-Control: no-cache` + ETag，浏览器每次带 `If-None-Match` 验证，正常应立即生效。
- 图标 URL 带 `?v=<配置版本>`，配置一变 URL 就变、绕开长缓存；不带 `v` 的手工访问只短缓存 5 分钟（机制见 [offline-and-pwa.md](offline-and-pwa.md)）。
- 若中间层 CDN 强行缓存了 `/api/site-settings/*`，需要为该路径放行或缩短 TTL。

## 数据库与迁移

### `drizzle-kit push` 要 DROP `fedify_kv_v2`，会删掉 Bot 私钥

- **现象**：本地 `pnpm db:push` 提示 `You're about to delete fedify_kv_v2 table with N items`；线上 migrate 跑的是 `push --force`，会**自动批准**这条 DROP。⚠️ 更隐蔽的是：**表为空时连提示都不出现**，drizzle 静默 DROP。
- **原因**：`fedify_kv_v2` / `fedify_message_v2` 由 `@fedify/postgres` 自建自管、不在本仓库 Drizzle schema 里，push 把它们当成「多余的副本」；而 `fedify_kv_v2` 存着 Bot 的 ActivityPub **密钥对**（键形如 `["_botkit","bots",{username},"keyPairs"]`），删掉即永久丢失联邦身份。
- **解法**：把这两张表移出 `public` —— Fedify 的表统一建在独立 schema `fedify` 下（独立连接设 `search_path`，启动时 `ensureFedifySchema()` 幂等建 schema），drizzle 默认只管理 `public`，结构上够不着；`drizzle.config.ts` 另留 `tablesFilter: ["*", "!fedify_*"]` 作第二道防线。
- **注意**：`fedify` schema 必须先于 Fedify 建表存在（Fedify 只建表不建 schema，缺失时建表会失败）。移库后 `public` 里的旧 `fedify_*` 空表可手工 DROP。

### 加唯一约束时 `push` 会问「是否 truncate 表」

- **现象**：给已有数据的表加 `.unique()` 后，`drizzle-kit push` 会问 `Do you want to truncate <table> table?`，而 `--force` 会走 truncate 分支（清空该表）。
- **解法**：别用 `--force` 硬跑。先用等价 SQL 手工加约束 —— 数据无重复时必然成功且保留数据，之后 `push` 会认为结构已对齐：
  ```sql
  ALTER TABLE bots ADD CONSTRAINT bots_preferred_username_unique UNIQUE (preferred_username);
  ```
- **同坑的非交互表现**：CI / 管道里没有 TTY 时 drizzle 直接报 `Interactive prompts require a TTY terminal` 退出，什么都没改；想加约束就走上面的手工 SQL（旧值全是 NULL 时 NULL 之间不冲突，加约束不会因重复失败）。
- **推论**：**新加的可空列别顺手加 `.unique()`** —— 唯一性是装饰性的，代价却是一次可能清空整表的迁移（`user.timeline_db_name` 就是这么处理的，见 [auth-schema.ts](../packages/hono-server/src/db/auth-schema.ts) 的注释）。

### `pnpm db:push` 没跑，登录接口直接 500

- **现象**：`POST /api/auth/sign-in/email` 返回 500 且**响应体为空**，所有需要登录的接口都 401（看起来像认证坏了）；只有 `psql` 里能看到 `column "timeline_db_name" does not exist`。
- **原因**：Better Auth 查询 `user` 表用的是 Drizzle schema 里的完整列集合，**代码先于结构上线**（新增 `user.timeline_db_name` / `user_timeline_settings` 但没 `db:push`）时，任何读用户行的查询都报 SQL 错误。错误没有回显到 HTTP 响应里，很容易误判成 cookie / 代理认证问题。
- **解法**：`pnpm db:push`（生产由 compose 里的 migrate 服务跑 `push --force`）。排查时先看服务端日志里的 Postgres 报错，别急着怀疑认证链路。

## 对象存储

### 上传报 `NoSuchBucket`

- **原因**：应用只做 PutObject，**不会自动建桶**。
- **解法**：首次部署后手动建一次（命令见 [docker-deployment.md](docker-deployment.md) 第 9 节）。

### 用未签名请求探测 SeaweedFS 的 S3 端口返回 403

- **说明**：这是 `AccessDenied` 的正常响应，说明服务在监听，**不是故障**。

## 本地环境与工具

### `git push` 报 `Bad owner or permissions on /etc/ssh/ssh_config.d/...`

- **现象**：SSH 到 GitHub 直接失败，提示该文件属主/权限不对（WSL 里该符号链接属主成了 `nobody:nogroup`）。
- **解法**（二选一）：
  - 修正系统文件：`sudo chown -R root:root /etc/ssh/ssh_config.d /usr/lib/systemd/ssh_config.d`
  - 或让 git 绕过所有 ssh 配置：`git config --global core.sshCommand "ssh -F /dev/null -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`

### dev compose 的服务绑在 `0.0.0.0`，局域网可直连

- **风险**：PostgreSQL / CouchDB / Redis 都是弱口令（`rssfed` / `admin` / 无密码），而端口映射是 `5432:5432` 这类全网卡绑定，同网段设备可直接连上开发数据库。
- **解法**：全部改成 `127.0.0.1:5432:5432`，只绑宿主回环。手机调试用不到这些端口（只用到前端 3000 与后端 3001）。

## 部署环境相关

### 服务器无法 `git clone` 或拉取 Docker Hub 镜像

- **现象**：`github.com` 的 HTTPS 与 `registry-1.docker.io` 均超时；但 **GitHub SSH(22) 可用**、`ghcr.io` 可用、云厂商内网镜像加速源可用。
- **影响**：代码同步走 SSH；基础镜像走加速源；自有镜像走 ghcr。

### 服务器内存不足，构建 Nuxt 会 OOM

- **现象**：容器内 `nuxt build` 被 OOM killer 干掉（机器约 2G 内存）。
- **解法**：镜像一律在 CI（或本地）构建后推送/传输，服务器只 `pull` 与运行。见 [docker-deployment.md](docker-deployment.md) 第 10 节。
