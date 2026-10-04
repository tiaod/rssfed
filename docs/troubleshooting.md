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
- **快速验证**（库名从 `GET /api/couchdb/targets` 拿）：
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
- **排查**（路径里的库名是随机生成的，不是 `feed_<feedId>`；映射见 `GET /api/couchdb/targets`）：
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

### 同步全报 `Database does not exist`：库名还登记着，库却没了

- **现象**：订阅列表正常、`GET /api/couchdb/targets` 也下发库名，但同步返回 CouchDB 的 `{"error":"not_found","reason":"Database does not exist."}`。
- **原因**：库名解析走快路径：已登记的库名直接返回、不再校验库是否还在（[client.ts](../packages/hono-server/src/couchdb/client.ts) 的 `resolveDatabase`），手工删库、数据卷丢失**不会自动重建**。
- **解法**：把对应行的库名置空，下次寻址/抓取会重新建库：
  ```bash
  docker exec hono-server-postgres-1 psql -U rssfed -d rssfed -c \
    "update feeds set couch_db_name = null where id='<feedId>';"
  ```
  用户状态库/ bot 库同理（`user` / `bots` 表的 `couch_db_name`）。重建出来的是**新库**，旧数据不会回来，本地 PouchDB 也会因远端库 URL 变化全量重同步一次。库级 `_security` 也只在建库时设置一次，改坏了同样用置空库名的方式重建。

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

- **现象**：A 登出、B 登录后，B 的时间线/订阅里出现 A 的订阅或已读状态；更麻烦的是 **B 的服务端 user-state 库被写入了 A 的文档**。
- **原因**：旧版本本地 PouchDB 用固定库名（`rssfed-entries` / `rssfed-user-state`），而 user-state 库是**双向** live 同步，装着 A 数据的本地库会把文档推到 B 的远端库；增量同步记录（localStorage 的 `rssfed-synced-feeds`）也是全局 key，会让 B 整段跳过。
- **解法**：本地库名与同步记录 key 都带上账号 id（[utils/localDbName.ts](../packages/nuxt-client/app/utils/localDbName.ts)），换账号即换一套本地库；会话未就绪或未登录落到 `guest`。启动清理**删除**旧固定库名而非搬进新库 —— 旧库混着多个账号的数据，搬进去会把上个账号的数据固化后再推上远端。
- **已经被写脏的远端库**：查该账号 user-state 库里的 `subscription:` 文档（`GET /api/couchdb/proxy/<库名>/_all_docs?startkey="subscription:"&endkey="subscription:\uffff"&include_docs=true`，库名从 `GET /api/couchdb/targets` 拿），删掉不属于该账号的文档；本地侧换了库名会重新全量同步一次。

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
