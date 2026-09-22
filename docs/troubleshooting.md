# 踩坑记录

按现象组织，便于搜索。每条都记录**现象 → 原因 → 解法**，多数是"看代码看不出来、只在特定环境下暴露"的那类问题。

## 构建与启动

### `node dist/index.js` 报 `ERR_MODULE_NOT_FOUND`

- **现象**：`pnpm --filter @rssfed/hono-server build`（tsc）成功，但用 node 直接跑产物时找不到 `./app` 等相对模块。
- **原因**：`tsconfig` 用 `moduleResolution: bundler`，源码里的相对导入不带扩展名；tsc 原样输出，而 Node 的 ESM 解析要求显式扩展名。
- **解法**：后端改用 esbuild 打包（`build:bundle`），把本地源码内联成单文件，第三方依赖保持 external。Docker 镜像与 CI 都走这条路径。

### 容器里跑临时脚本报 `ERR_MODULE_NOT_FOUND`

- **现象**：`docker compose exec server node /tmp/check.mjs` 找不到 `@aws-sdk/client-s3` 等依赖。
- **原因**：ESM 从**脚本所在位置**向上查找 `node_modules`，`/tmp` 不在 `/app` 之下。
- **解法**：把脚本放进应用目录再执行，例如 `docker compose cp check.mjs server:/app/packages/hono-server/`，或用 `exec -w /app/packages/hono-server`。

## 配置与环境变量

### server 报 `You are not a server admin`，CouchDB 代理认证配置失败

- **现象**：容器日志出现该错误，`couchdbs` 的 proxy auth 没配上。
- **原因**：`COUCHDB_USER` 只在 `env_file` 里或根本没设，而 `couchdb/client.ts` 对它的默认值是**空字符串**（不是 `admin`），于是 Basic 认证变成 `:password`。
- **解法**：编排里给 server 显式传 `COUCHDB_USER: ${COUCHDB_USER:-admin}`，保证与 CouchDB 容器用的是同一个用户名。

### 登录后看不到任何订阅内容，`/api/couchdb/proxy/*` 全部 401

- **现象**：页面能打开、能登录，但时间线与订阅列表空白。DevTools 里 `/api/couchdb/proxy/<库名>/...`（如 `/api/couchdb/proxy/feed_xxxxxxxxxxxxxxxxxxxxxxxx/_changes`）全返回 401，响应体是 `{"error":"unauthorized","reason":"You are not authorized to access this db."}`——这是 **CouchDB** 的措辞；Hono 自己拦下的是 `{"error":"unauthorized"}`（那才是会话 cookie 失效）。
- **原因**：CouchDB **只在进程启动时**读取 `chttpd/authentication_handlers`（`chttpd:set_auth_handlers/0` 把解析结果固化进 application env），启动后再用 config API 改这项配置对运行中的进程无效；CouchDB 3.5 又移除了 `POST /_restart`（实测 404），应用侧无法自行触发重载。而 server 的流程是「连上 CouchDB → 才写配置」，于是 `proxy_authentication_handler` 从未挂载：所有带 `X-Auth-CouchDB-*` 的转发请求都被当成匿名用户，被库级 `_security`（`members.roles = ["user"]`）拒绝，PouchDB 同步整体失败。
- **排查**：进 CouchDB 容器看运行时认证链——
  ```bash
  docker exec <couchdb 容器> curl -s http://localhost:5984/_session
  # 正常：{"info":{"authentication_handlers":["cookie","proxy","default"]}}
  # 故障：{"info":{"authentication_handlers":["cookie","default"]}}   ← 缺 proxy
  ```
  注意 `_node/_local/_config/chttpd/authentication_handlers` 里**写着** proxy 也没用，那只是配置而非运行时状态。
- **解法**：把这段配置固化到 CouchDB 启动时就会读的 ini —— [deploy/couchdb-proxy-auth.ini](../deploy/couchdb-proxy-auth.ini)，两个 compose 都已挂到 `/opt/couchdb/etc/local.d/00-proxy-auth.ini`。两个文件名上的坑：**不能加 `:ro`**（官方 entrypoint 会对 `/opt/couchdb` 下的文件 `chown`，只读挂载让 chown 失败，`set -e` 下容器无日志直接 exit 1），**前缀用 `00-`**（CouchDB 写配置时落在 local.d 里最后加载的 `docker.ini`，排到它后面会让 `COUCHDB_PROXY_SECRET` 被写进受版本控制的文件）。已经跑歪的实例执行一次 `docker compose --env-file .env.production -f docker-compose.prod.yml up -d couchdb server` 即可（重建 couchdb 会丢掉容器内的 `docker.ini`，所以 server 必须一起重建，让 `COUCHDB_PROXY_SECRET` 重新写入）。server 启动时会自动校验（[couchdb/proxy-auth.ts](../packages/hono-server/src/couchdb/proxy-auth.ts)），未挂载就在日志里给出上述修复动作。
- **注意**：`chttpd_auth/secret` 与 `proxy_use_secret` 是**每次请求读取**的动态配置，仍由 server 启动时写入，不进 ini、不入版本控制。

### 改了 `.env.production` 却不生效

- **原因**：`env_file` 的变量在**容器创建时**注入，`docker compose restart` 不会重新读取。
- **解法**：用 `up -d --no-build <service>` 重建容器。

### 未知的 `STORAGE_DRIVER` 静默走了别的后端

- **现象**：配置里写了拼错的驱动名，服务照常启动，但头像上传失败。
- **原因**：分派逻辑只判断了已知值，其余情况落到默认分支。
- **解法**：`createStorageFromEnv()` 现在对未知取值**直接抛错**，让配置错误在启动时就暴露，而不是运行期才以"上传失败"的形式出现。

### 示例配置与真实环境脱节

- **现象**：`.env.example` 里写的是 Garage（`localhost:3900` / `region=garage`），而实际 dev 环境用的是 SeaweedFS（`8333` / `us-east-1`），照示例配连不上。
- **教训**：示例文件是文档，改环境时容易忘记同步。发现后已把示例对齐到实际在用的服务。

### 控制台刷 `GET /api/couchdb/proxy/` 404（数量≈订阅数+1）

- **现象**：Network/控制台里每个订阅同步时都出现一条 `GET /api/couchdb/proxy/` 404。功能看起来正常，没有别的报错。
- **原因**：这是 **PouchDB 的实例 uuid 探测**，不是脏数据，也不代表某个订阅有问题。PouchDB 每次建立复制前都会调用远端库的 `id()`（内部 `api.id` → `genUrl(host, '')`，见 pouchdb 的 `lib/index-browser.js`），请求「**去掉库名段之后的那个路径**」。代理地址是 `/api/couchdb/proxy/<库名>`，去掉库名段就是 `/api/couchdb/proxy/` —— 所以**所有订阅的探测请求都是同一条路径**，与具体是哪个源无关。拿不到 uuid 时 PouchDB 会回退用远端库 URL 当复制 id，同步功能不受影响，只是刷 404。
- **快速验证**（Node 里跑一遍就能看到真实请求路径；库名从 `GET /api/couchdb/targets` 拿）：
  ```js
  const PouchDB = require('pouchdb')
  const db = new PouchDB('http://localhost:3001/api/couchdb/proxy/feed_xxxxxxxxxxxxxxxxxxxxxxxx')
  await db.id() // 实际发出 GET .../feed_xxx/ 和 GET .../proxy/（后者就是那条 404）
  ```
- **解法**：后端对探测路径返回 CouchDB 风格的根信息（`couchRootInfo`）：[routes/couchdb.ts](../packages/hono-server/src/routes/couchdb.ts)，回归用例 [couchdb-proxy-route.test.ts](../packages/hono-server/src/__tests__/couchdb-proxy-route.test.ts)。**响应里必须不带 `uuid`**：`api.id` 一旦拿到 uuid 就会改用 `uuid + 库名` 当复制 id，既有 checkpoint 全部因换名失效，每个订阅白跑一次全量重同步；不带 uuid 时 PouchDB 回退用远端库 URL，复制 id 与修复前完全一致。这个坑我踩过：第一版探测响应带了 uuid，紧接着就看到每个 feed 各来一条 `_local/...` 404（checkpoint 换名重建）。
- **别再从这条 404 推断「有脏订阅」**：代理不再按业务 id 拼地址，空 feedId 的订阅在前后端都会被过滤掉（前端 `isValidDbId`（[usePouchDb.ts](../packages/nuxt-client/app/composables/usePouchDb.ts)）、后端 `listSubscriptionsForUser`（[services/feeds.ts](../packages/hono-server/src/services/feeds.ts)）），根本不会进入复制队列。

### 同步时 `.../proxy/<库名>/_local/<id>` 返回 404

- **现象**：Network 里出现 `GET /api/couchdb/proxy/<库名>/_local/xxxx==` 404，响应体是 CouchDB 的 `{"error":"not_found","reason":"missing"}`。
- **原因**：这是 PouchDB 复制前的 **checkpoint 读取**。`_local` 文档不存在时 CouchDB 就返回 404，而 PouchDB 专门处理这个分支（`updateCheckpoint` 里对 404 的注释：「PouchDB is just checking if a remote checkpoint exists.」），随后从头复制、结束时 PUT 写入 checkpoint。**它是正常链路的一部分，不是错误**：只有 checkpoint 尚未建立的那一次会 404，之后同一复制 id 会命中并返回 200。
- **排查**（路径里的库名是随机生成的，不是 `feed_<feedId>`；也可以直接 `GET /api/couchdb/targets` 看映射）：
  ```bash
  docker exec hono-server-postgres-1 psql -U rssfed -d rssfed -c \
    "select couch_db_name from feeds where id='<feedId>';"
  curl -s -u admin:admin "http://localhost:5984/<couch_db_name>/_local_docs?include_docs=true"
  ```
  只要 PouchDB 复制过，这里就能看到 `_local/<replicationId>` 文档（`_rev` 递增、带 `last_seq`）。
- **什么时候才是真问题**：**每次**同步都 404 且库里始终没有 checkpoint —— 说明 PUT 失败（权限或代理问题），会导致每个订阅反复全量复制。另外，改过 `COUCHDB_PROXY_SECRET` 会让复制 id 变化、checkpoint 一次性全部作废重来。
- **代理地址的库名一变就会重同步一次**：PouchDB 的复制 id 由本地库名 + 远端库 URL 决定，远端 URL 变了（库名重建、代理地址格式调整）就会全量重同步一次。

### 同步成片 `400 invalid_database`：前端还是旧版本

- **现象**：升级后端后，Network 里同步请求全部 `400 {"error":"invalid_database","reason":"... 不是本服务可代理的库名", ...}`。
- **原因**：代理现在只接受真实库名（`/api/couchdb/proxy/<库名>`），而旧版本前端仍按业务 id 拼地址（`/api/couchdb/proxy/feed/<feedId>`）。Service Worker 装好新版本后会先待命，等页面提示用户更新才激活，所以旧页面可能还跑着旧 JS。
- **解法**：刷新页面（换成新构建产物）即可，错误响应里的 `hint` 也写了这条。

### 同步全报 `Database does not exist`：库名还登记着，库却没了

- **现象**：订阅列表正常、`GET /api/couchdb/targets` 也能下发库名，但同步请求返回 CouchDB 的 `{"error":"not_found","reason":"Database does not exist."}`。
- **原因**：库名解析走快路径 —— 业务表里已登记的库名直接返回，不再顺手校验库是否还在（见 [client.ts](../packages/hono-server/src/couchdb/client.ts) 的 `resolveDatabase`；这条路径在抓取、写条目、查条目上每次都要走，原先的「每次都 `GET /db` + `PUT /_security`」纯属白打请求）。所以手工删库、CouchDB 数据卷丢失这类情况**不会自动重建**。
- **解法**：把对应行的库名置空，下次寻址/抓取会重新建库：
  ```bash
  docker exec hono-server-postgres-1 psql -U rssfed -d rssfed -c \
    "update feeds set couch_db_name = null where id='<feedId>';"
  ```
  用户状态库/ bot 库同理（`user` / `bots` 表的 `couch_db_name`）。注意重建出来的是**新库**，旧数据不会回来（库本身已不存在），本地 PouchDB 也会因远端库 URL 变化全量重同步一次。
- **另一个代价**：库级 `_security` 也只在建库时设置一次，不再每次重写。如果有人手工改坏了某个库的 `_security`，同样用置空库名的方式重建。

## 反向代理与网络

### https 页面上附件地址是 `http://`，图片被浏览器拦截

- **现象**：头像上传成功，`avatarUrl` 返回 `http://<域名>/api/files/...`。
- **原因**：`avatar.ts` 用 `new URL(c.req.url).origin` 拼 URL，而反代之后 Node 适配器拿到的协议仍是 http（未必采用 `X-Forwarded-Proto`）。
- **解法**：优先取配置的对外地址（`BOTS_BASE_URL` / `BETTER_AUTH_URL`），只有都没配时才回退到请求 origin。

### 只转 `/api/*` 会让联邦功能整体 404

- **原因**：Hono 除 `/api/*` 外，还用 `app.all("*")` 兜底承载 ActivityPub 端点。
- **解法**：反代必须同时转发 `/mcp`、`/mcp/*`、`/.well-known/*`、`/nodeinfo/*`、`/ap/*`、`/@*`。规则见 [deploy/Caddyfile](../deploy/Caddyfile)。（`/users/*`、`/inbox` 是 Fedify 默认路由与共享 inbox，当前未启用，实测 404，留着只为将来启用时不至于又漏。）另外 `/mcp` 不能做 301/307，否则 MCP 客户端跟随跳转会丢掉 `Authorization` 头。

### webfinger 正常但 actor 取不到：反代漏放行 `/ap/*`

- **现象**：在 Mastodon 里能搜到 bot 账号（说明 webfinger 解析成功），但账号加载不出来、无法关注、也收不到投递；同时站点首页与 `/api/*` 一切正常，极易误判成联邦代码有问题。
- **原因**：BotKit 的 actor 真实路径是 **`/ap/actor/{username}`**，而反代 matcher 里放行的却是**后端并不存在的 `/users/*`**（实测 404）。webfinger 走 `/.well-known/*`，那条是被放行的，所以它照常返回 200 并给出 `/ap/actor/...` 链接；外部实例拿着这个链接回来取时才落到 Nuxt 上 404。
- **解法**：反代 matcher 必须包含 `/ap/*`（以及 profile 页的 `/@*`），改完 `caddy reload`，然后用这条确认：
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' \
    https://<域名>/ap/actor/<bot名>     # 必须 200；返回形如 {"statusCode":404,...} 的 JSON 就是漏了
  ```
- **记录**：2026-09-21 上线验收实测踩到，详见 [cloud-deployment-todo.md](cloud-deployment-todo.md) 的「本地端到端验收」一节。

### 页面文字正常但图标整片空白：`/api/*` 抢走了 Nuxt 的图标接口

- **现象**：首页、导航、按钮都在，但所有 lucide 图标不显示（骨架期有过一个转圈图标，之后空白），控制台里 `/api/_nuxt_icon/lucide.json?icons=...` 返回 404 `404 Not Found`（`content-type: text/plain`、带 `access-control-allow-credentials`，是 Hono 的 404 而不是 Nuxt 的）。
- **原因**：`@nuxt/icon` 的本地图标 API 挂在 Nuxt/Nitro 上，默认路径是 **`/api/_nuxt_icon/:collection`**（见 `.nuxt/types/nitro-routes.d.ts`，这是本项目里唯一一条 `/api` 前缀的 Nitro 路由）。反代若用 `path /api/*` 无差别甩给后端 Hono，这条也会被抢走；后端没有该路由 → 404。SSR 输出的只是 `<span class="iconify i-lucide:xxx">`，真正的图标数据由客户端来取，所以取不到就整片空白。
- **解法**：在 `@backend` 那条 `reverse_proxy` **之前**放行图标接口（顺序不能反，Caddy 同指令按书写顺序匹配）：
  ```
  @nuxt_icon path /api/_nuxt_icon /api/_nuxt_icon/*
  reverse_proxy @nuxt_icon web:3000
  ```
  改完 `caddy reload`，用 `curl -s -o /dev/null -w '%{http_code}\n' 'https://<域名>/api/_nuxt_icon/lucide.json?icons=refresh-cw'` 验证：返回 200 且是 `application/json` 才算修好；只改前端重新构建没用。
- **根治**：前端已开 `icon.clientBundle`（见 `nuxt.config.ts`），图标数据编译期内联进客户端 bundle，客户端渲染不再请求 `/api/_nuxt_icon` —— 断网可用，也不再有"反代漏放行就整片空白"这个失败模式。上面的放行规则仍建议保留：它无害，而且将来若出现动态拼接、没被打进 bundle 的图标名，客户端还会回退到这个接口。
- **记录**：2026-09-21 线上（rssfed.uvcat.cn）实测踩到。

### 两个「创建机器人」按钮的图标一直不显示：图标名在 lucide 里不存在

- **现象**：[bots/index.vue](../packages/nuxt-client/app/pages/bots/index.vue)、[bots/explore.vue](../packages/nuxt-client/app/pages/bots/explore.vue) 的「创建机器人」按钮图标空白，与网络、反代、离线状态都无关。
- **原因**：写的是 `i-lucide-bot-plus`，而 lucide 集合里只有 `bot` / `bot-message-square` / `bot-off`，**没有 `bot-plus`**。开了 `clientBundle` 后这类错误会直接让构建失败（`Invalid icon ...` / `failed` 列表），反而更容易发现。
- **解法**：改成集合里存在的图标（本次改为 `i-lucide-plus`）；校验脚本见下方「图标名全量校验」。
- **记录**：2026-09-21 排查线上图标问题时发现，全项目仅此两处无效。

### 图标名全量校验（改了图标或升级图标集后跑一次）

```bash
node - <<'JS'
const fs = require('fs'), path = require('path')
const collections = fs.readdirSync('node_modules/@iconify-json')
const data = Object.fromEntries(collections.map(c => [c, JSON.parse(fs.readFileSync(`node_modules/@iconify-json/${c}/icons.json`, 'utf8'))]))
const RE = new RegExp(`i-(${collections.join('|')})-([a-z0-9-]+)`, 'g')
const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, acc) : /\.(vue|ts|js|mjs)$/.test(e.name) && acc.push(p) } return acc }
let bad = 0
for (const f of walk('packages/nuxt-client/app')) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(RE)) {
    const [, col, name] = m
    if (!(name in data[col].icons) && !(name in (data[col].aliases || {}))) { console.log(`无效图标 ${m[0]} → ${f}`); bad++ }
  }
}
console.log(bad ? `${bad} 处无效` : '全部有效')
JS
```

## 离线与 Service Worker

### 断网后页面完全打不开（连壳都没有）

- **现象**：断网后访问站点是浏览器的「无法访问此网站」，不是应用内的离线提示。
- **原因**：`public/sw.js` 没有被注册，或注册失败。**开发环境故意不注册**（`import.meta.dev` 短路，否则缓存优先会挡住 HMR），要看离线效果必须跑生产构建：`pnpm --filter @rssfed/nuxt-client build && node packages/nuxt-client/.output/server/index.mjs`。
- **排查**：浏览器 DevTools → Application → Service Workers，应看到 `/sw.js` 处于 activated；Cache Storage 里应有 `rssfed-<构建号>` 且条目数 ≈ 60。另外确认 `/sw.js` 与 `/sw-manifest.json` 能直接打开（反代别拦这两条路径）。
- **注意**：Service Worker 只在安全上下文生效（HTTPS 或 localhost）。**前面若套了 CDN，要给 `/sw.js` 禁用缓存**，否则更新永远下不来。

### 部署了新版本，页面还是旧的

- **原因与解法**：SW 更新后不会立刻接管，页面会弹「有新版本可用」的提示，点刷新才切换。这是刻意设计的——新版 SW 一激活就清掉旧构建的缓存，自动接管会让正在用旧页面的标签页加载不到旧 chunk 而白屏。
- 提示一直不出现，多半是 `/sw.js` 被中间层缓存了（见上一条）。

### 离线打开某个页面，看到的是「当前处于离线状态」

- **说明**：这个路径之前没访问过，SW 拿不到同路径的 HTML，于是回退到预渲染的离线外壳 `/offline`。客户端接管后一般会按地址栏 URL 渲染出真实页面；如果目标页依赖尚未同步到本机的数据，就会停在外壳上。
- 外壳只是兜底，页面上给了「打开时间线」入口。想让某个入口离线必达，在线时至少访问一次即可（HTML 会被缓存）。

### 离线时数据是空的

- **数据不在 Service Worker 里**：条目、订阅、已读/收藏都在浏览器 PouchDB（IndexedDB）。新设备/新浏览器首次必须联网同步一次，之后才有离线内容。SW 只负责让页面能打开。
- 清过浏览器站点数据、或换过浏览器配置，都会丢掉本地库，需要重新联网同步。

### 同一浏览器换账号后，看到（并写进了）上一个账号的数据

- **现象**：A 账号登出、B 账号登录，B 的时间线/订阅里出现 A 的订阅或已读状态；更麻烦的是 **B 的服务端 user-state 库被写入了 A 的文档**。
- **原因**：旧版本本地 PouchDB 用固定库名（`rssfed-entries` / `rssfed-user-state`），而用户状态库走的是**双向** live 同步 —— 本地这份装着 A 数据的库会把文档推送到 B 的远端库。增量同步记录（localStorage 的 `rssfed-synced-feeds`）也是全局 key，会让 B 误以为自己已经同步过而整段跳过。
- **解法**：本地库名与同步记录 key 都带上账号 id（[utils/localDbName.ts](../packages/nuxt-client/app/utils/localDbName.ts)），换账号等于换一套本地库；会话未就绪或未登录落到 `guest`，那段时间的数据不会被任何账号继承。启动清理会**删除**旧的固定库名（`rssfed-entries` / `rssfed-user-state`）而不是把它们搬进新库 —— 旧库里可能混着多个账号的数据，搬进去反而会把上一个账号的数据固化下来再推上远端。
- **已经被写脏的远端库怎么办**：查该账号 user-state 库里的 `subscription:` 文档（`GET /api/couchdb/proxy/<库名>/_all_docs?startkey="subscription:"&endkey="subscription:\uffff"&include_docs=true`，库名从 `GET /api/couchdb/targets` 拿），确认哪些订阅不属于该账号后删除对应文档即可；本地 PouchDB 侧因为换了库名，会重新全量同步一次。

## 数据库与迁移

### `drizzle-kit push` 要 DROP `fedify_kv_v2`，会删掉 Bot 私钥

- **现象**：本地 `pnpm db:push` 提示 `You're about to delete fedify_kv_v2 table with N items`；线上 migrate 服务跑的是 `push --force`，会**自动批准**这条 DROP。⚠️ 更隐蔽的是：**表为空时连这条提示都不会出现**，drizzle 静默 DROP。
- **原因**：`fedify_kv_v2` / `fedify_message_v2` 由 `@fedify/postgres` 自建自管，不在本仓库的 Drizzle schema 里，push 因此把它们当成「多余的副本」。而 `fedify_kv_v2` 存着 Bot 的 ActivityPub **密钥对**（键形如 `["_botkit","bots",{username},"keyPairs"]`），删掉即永久丢失联邦身份 —— 已关注的实例会因公钥失效而无法验证签名。
- **解法**：把这两张表移出 `public` —— Fedify 的表统一建在独立 schema `fedify` 下。做法是给 BotKit 的独立连接设置 `search_path`（`bots/index.ts` 的 `botkitSql`，走 PG 启动参数 `options`），并在启动流程里由 `ensureFedifySchema()` 幂等建 schema。drizzle 默认只管理 `public`，从此结构上够不着它们。`drizzle.config.ts` 另保留 `tablesFilter: ["*", "!fedify_*"]` 作为第二道防线。
- **注意**：`fedify` schema 必须先于 Fedify 建表存在 —— Fedify 只建表、不建 schema，schema 缺失时建表会失败（由 `ensureFedifySchema()` 保证）。移库后 `public` 里的旧 `fedify_*` 空表可手工 DROP。

### 加唯一约束时 `push` 会问「是否 truncate 表」

- **现象**：给已有数据的表加 `.unique()` 后，`drizzle-kit push` 会问 `Do you want to truncate <table> table?`，而 `--force` 会走 truncate 分支（即清空该表）。
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

- **现象**：SSH 到 GitHub 直接失败，提示该文件的属主/权限不对（WSL 里该符号链接属主成了 `nobody:nogroup`）。
- **解法**（二选一）：
  - 修正系统文件：`sudo chown -R root:root /etc/ssh/ssh_config.d /usr/lib/systemd/ssh_config.d`
  - 或让 git 绕过所有 ssh 配置：`git config --global core.sshCommand "ssh -F /dev/null -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`

### dev compose 的服务绑在 `0.0.0.0`，局域网可直连

- **风险**：PostgreSQL / CouchDB / Redis 用的都是弱口令（`rssfed` / `admin` / 无密码），而端口映射写的是 `5432:5432` 这类全网卡绑定 —— 同网段设备可以直接连上开发数据库。
- **解法**：全部改为 `127.0.0.1:5432:5432` 形式，只绑宿主回环。手机调试用不到这些端口（只用到前端的 3000 与后端的 3001）。

## 部署环境相关

### 服务器无法 `git clone` 或拉取 Docker Hub 镜像

- **现象**：`github.com` 的 HTTPS 与 `registry-1.docker.io` 均超时；但 **GitHub SSH(22) 可用**、`ghcr.io` 可用、云厂商内网镜像加速源可用。
- **影响**：代码同步走 SSH；基础镜像走加速源；自有镜像走 ghcr。

### 服务器内存不足，构建 Nuxt 会 OOM

- **现象**：容器内 `nuxt build` 被 OOM killer 干掉（机器约 2G 内存）。
- **解法**：镜像一律在 CI（或本地）构建后推送/传输，服务器只 `pull` 与运行。见 [docker-deployment.md](docker-deployment.md) 第 10 节。
