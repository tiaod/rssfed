# RSSFed 云端部署待办

> 初版基于 commit `09258b4` 评估。**本文档已更新到当前工作区状态**：交付层（镜像、编排、反代、部署文档）已完成并本机实测，P0 的代码层安全开关也已修掉。
> 图例：✅ 已完成（附验收证据）｜⚠️ 部分完成｜❌ 未做

## 结论

交付层已完成并已上云（2026-09-20 首次部署，见文末「当前部署实例」）；代码层安全开关（信任域、看板鉴权、示例凭据）已修复。

2026-09-21 在开发环境补跑了一轮端到端验收（见「本地端到端验收」），**发现并修复了一个会让联邦功能在生产整体不可用的反代缺陷**：反代漏放行 `/ap/*`。仓库 `deploy/Caddyfile` 与**服务器宿主机 Caddy 均已修复并 reload**，公网复验确认 `/ap/*`、`/@*` 已到达后端。

仍未落地的只有**备份**（仓库零实现）；浏览器 IndexedDB 离线读与全部公网项仍需人工验证。

## 已就绪（无需改动）

- [x] `pnpm typecheck` 通过（hono-server + nuxt-client）
- [x] `pnpm --filter @rssfed/hono-server build` 通过 → `dist/index.js`
- [x] `pnpm --filter @rssfed/nuxt-client build` 通过 → `.output/server/index.mjs`（node-server preset）
- [x] 健康检查 `/api/health`：[app.ts:40](../packages/hono-server/src/app.ts#L40)
- [x] SIGTERM/SIGINT 优雅关闭：[index.ts:105](../packages/hono-server/src/index.ts#L105)
- [x] 反代后取真实协议：`behindProxy: true`，[bots/index.ts:20](../packages/hono-server/src/bots/index.ts#L20)
- [x] 配置全部走环境变量，[.env.example](../packages/hono-server/.env.example) 齐全
- [x] MCP 端点尾部斜杠兼容（不做重定向），见 [ai-mcp-assistant.md:196](ai-mcp-assistant.md#L196)
- [x] `drizzle-kit push` 支持 `--force` / `--strict`（v0.45.2 实测）

## P0 · 阻断项

### 1. 应用镜像 ✅

- **实现**：[Dockerfile](../Dockerfile) 单文件多 target —— `server`（Hono）、`web`（Nuxt SSR）、`migrate`（建表）、`prod-deps`（只装后端生产依赖）。
- **要点**：
  - 多阶段构建，运行镜像只留产物 + production 依赖，devDependencies 不进最终镜像；
  - `sharp` 原生依赖随 `node:22-alpine`（musl）走预编译二进制，实测 AVIF 编码成功；
  - [.dockerignore](../.dockerignore) 排除 `node_modules`、`.pnpm-store`、`.output`、`dist`、`.git` 与所有 `.env*`。
- **额外修掉的坑**：`tsconfig` 是 `moduleResolution: bundler`，源码相对导入无扩展名，`tsc` 产物无法被 Node ESM 直接执行；改用 `build:bundle`（esbuild，依赖保持 external）打包，详见 [docker-deployment.md](docker-deployment.md) 第 2 节。
- **验收**：✅ 本机实测 —— 构建通过、容器 healthy、`/api/health` 200、SSR 首页 200、`web` 267 MB / `server` 729 MB。

### 2. 生产编排 ✅

- **实现**：[docker-compose.prod.yml](../docker-compose.prod.yml)。
  - 依赖服务（postgres/couchdb/redis）**不映射任何宿主端口**，只在 compose 网络内可达；
  - 口令与密钥全部来自 `.env.production`，仓库里只有 [.env.production.example](../.env.production.example)；
  - dev 专用的 `pgadmin` 不再出现；`seaweedfs` 从 dev profile 提升为正式服务（不映射宿主端口，附件走 `/api/files/*` 代理）；RSSHub 以注释形式给出官方镜像接法；
  - 应用容器默认只绑 `127.0.0.1`（供宿主反代），公网只能走反代。
- **验收**：✅ 本机实测五个服务全 healthy；迁移建出 13 张表；server 日志出现 `[CouchDB Config] proxy auth configured`。
- **实测修正**：server 容器原先拿不到 `COUCHDB_USER`（compose 只传给了 couchdb 服务），导致 proxy auth 配置报 `You are not a server admin`；已在编排里显式传递。

### 3. 反向代理与 TLS ✅（规则就绪，公网验收未跑）

- **实现**：[deploy/Caddyfile](../deploy/Caddyfile)，`caddy validate` 实测通过（HTTPS 域名与 `http://localhost` 两种场景）。
- 分流规则：`/api/*`、`/mcp`、`/mcp/*`、`/.well-known/*`、`/nodeinfo/*`、**`/ap/*`**、**`/@*`** 走 Hono；其余走 Nuxt；`/admin/queues` 直接 404。⚠️ 初版漏了 `/ap/*` 与 `/@*`（误写成后端并不存在的 `/users/*`），2026-09-21 验收发现并修复，详见「本地端到端验收」一节。
- **要点**：TLS 终止在反代，`X-Forwarded-Proto` 由 Caddy 默认透传；Nuxt 与 Hono 同域以保持 cookie 同站。
- **未完成**：公网验收 curl（webfinger、`/mcp/` 非 3xx）需要真实域名，见文末清单。webfinger 与 actor 已于 2026-09-21 在本地验过（见「本地端到端验收」）。

### 4. 环境变量生产化 ✅

- **实现**：[.env.production.example](../.env.production.example) + 编排注入；`PUBLIC_URL` 一个变量同时驱动 Caddy 站点地址、`BETTER_AUTH_URL`、`BOTS_BASE_URL`、`CORS_ORIGINS` 与前端 runtime config。
- **验收（已修正判定方式）**：✅ 实测运行时注入生效 —— 容器里设置 `NUXT_PUBLIC_API_BASE_URL` 后，SSR HTML 中只有运行时地址、无构建期默认值。
  - ⚠️ 原验收标准「构建产物里搜不到 `localhost:3001`」是错的：Nuxt 会把 runtime config 的默认值编进产物，只要运行时能被环境变量覆盖就是正确的。判定要看**运行时行为**，不是搜产物。

### 5. 收紧认证信任域 ✅

- **实现**：
  - [config.ts:13](../packages/hono-server/src/config.ts#L13) 新增 `isProduction`；[config.ts:22](../packages/hono-server/src/config.ts#L22) 的 `isOriginAllowed` 在生产只认白名单，localhost 与私有网段的放行仅非生产生效；
  - [auth.ts:22](../packages/hono-server/src/auth.ts#L22) 改为 `isProduction ? allowedOrigins : [...allowedOrigins, "*"]`。
- **验收**：✅ 本机实测（`NODE_ENV=production` 容器）—— 恶意 Origin 的 CORS 预检不返回 `Access-Control-Allow-Origin`；白名单 Origin 正常返回；用恶意 Origin 打 `/api/auth/sign-in/email` 得到 `INVALID_ORIGIN` 403。

### 6. BullBoard 鉴权 ✅

- **实现**：抽出公共中间件 [require-admin.ts:13](../packages/hono-server/src/middleware/require-admin.ts#L13)（原先在 feeds 与 site-settings 里各有一份重复实现，已统一），看板在 [app.ts:61-63](../packages/hono-server/src/app.ts#L61-L63) 挂上精确路径与子路径两道校验。
- **验收**：✅ 本机实测 —— `/admin/queues` → 401，`/admin/queues/static/x` → 401，`/api/health` 仍 200（未误伤）。
- 反代层的 404 屏蔽保留，形成纵深防御。

### 7. 密钥轮换 ✅（远端待 force push）

- **已做**：[.env.example](../packages/hono-server/.env.example) 里的 Garage S3 凭据已换成占位符。
- **已清理历史**：那把 key 由初始 commit `27df94d` 写入 `packages/server/.env.example`（该包后改名 `packages/hono-server`），此后 60+ 个 commit 一直带着它。已用 `git filter-branch --tree-filter` 把全部历史中的这两处字符串替换为占位符（commit 结构、数量与 message 均保留，只有 hash 变化），并删除了 `refs/original` 备份、本地 `origin/*` 缓存 ref，清理 reflog 后 `gc` 回收旧对象。
  - 验证：对象库 851 个 blob 全量扫描 0 命中；`master` 与 `refactor/new-architecture` 两个分支 `git log -S` 命中 0；`git fsck` 无错误；`.git` 由 3.5 MB 降至 1.6 MB。
- **仍需你处理**：
  1. **force push**，否则远端（GitHub）仍是含 key 的旧历史：`git push --force origin master`，另一个分支同理。⚠️ **推送前不要 `git fetch`**，否则会把含 key 的旧对象拉回本地。
  2. 若仓库是 public、或该 key 曾用于任何真实环境，**请轮换 Garage/S3 凭据** —— 被 force push 掉的提交在一段时间内仍可能通过直接 SHA 访问。
  3. `BETTER_AUTH_SECRET`、`COUCHDB_PROXY_SECRET` 生产环境务必用 `openssl rand -hex 32` 生成，后者**必须固定**。


## P1 · 生产化（能跑但会出事）

### 8. 单副本约束或拆分 worker ⚠️

抓取调度与 BotKit 轮询是进程内 `setInterval`（[workers/index.ts:323](../packages/hono-server/src/workers/index.ts#L323)、[bots/index.ts:299](../packages/hono-server/src/bots/index.ts#L299)），worker 与 API 同进程。**短期**：已在编排注释与部署文档里锁定单副本。**长期**：拆出独立 worker 进程 + 分布式锁/leader election。

### 9. 数据持久化与备份 ⚠️

编排已为 postgres/couchdb/redis/caddy 配命名卷，但**备份策略未落地**。注意 CouchDB 每个订阅源一个库，是数据主体，别只备份 PostgreSQL；应用启动时会用 admin 凭证写 CouchDB proxy auth 配置，故编排里 CouchDB 必须先就绪（已配 healthcheck + depends_on）。

- **核实（2026-09-21）**：全仓库 grep `pg_dump` / `pg_restore` / `backup` / `备份` **零命中**，编排里也没有备份服务；进一步在**生产服务器上**核实：`ubuntu` 与 `root` 的 crontab、`/etc/cron.d`、systemd timers 均无任何 RSSFed 相关任务，`/var/backups` 里只有 apt/dpkg 的系统文件。**结论：备份完全未落地**，上线验收清单里「备份任务已配置并验证过一次恢复」为 ❌。
- 备份范围提示：PostgreSQL（用户 / 认证 / bots / 关联表）+ **CouchDB 全部 `feed_*` / `user-state-*` / `bot_*` 库** + `uploads-data` 卷（附件）。Redis 有 `--appendonly yes`，队列数据丢了可重建，优先级最低。
- **哪些可重抓、哪些不可重建**（决定取舍的关键）：`feed_*` 是 RSS 内容，理论上可重新抓取，但**只能抓回源站当前窗口内的条目**（RSS 普遍只提供最近 10~50 条），滚出窗口的历史条目永久丢失，且正文图片要重新下载并重跑 AVIF 压缩；而 `user-state_*` 存的是**用户的订阅关系（`subscription` 文档）与已读/收藏状态**，PostgreSQL 侧没有副本（详见 [ARCHITECTURE.md](../ARCHITECTURE.md) 的「为什么订阅关系在 CouchDB 而不在 PostgreSQL」），**完全不可重建**。因此即使决定不备份 `feed_*`，`user-state_*` 也必须带上。

### 10. schema 发布步骤 ✅

- [docker-compose.prod.yml](../docker-compose.prod.yml) 的 `migrate` 服务在 `server` 启动前单次执行 `drizzle-kit push --force`，`server` 用 `service_completed_successfully` 依赖它。
- **实跑确认**：`up -d --build` 会重建 migrate 容器并重跑；镜像未变而要重跑用 `docker compose ... run --rm migrate`。
- `--force` 会自动批准数据丢失语句（可能 truncate 表）：首次部署无风险，后续删列/改类型前先 `--verbose` 复核（见 [docker-deployment.md](docker-deployment.md) 第 5 节）。
- ⚠️ **2026-09-21 发现并已修的真实风险**：Fedify 自建自管的 `fedify_kv_v2` / `fedify_message_v2` 不在本仓库 schema 里，`push` 会把它们当成多余的表并 **DROP TABLE**（`--force` 自动批准；**空表时甚至不提示，直接静默删除**）。而 `fedify_kv_v2` 存着 Bot 的 **ActivityPub 密钥对**，被删即永久丢失联邦身份（不可重建）。**已把这两张表迁到独立 schema `fedify`**（drizzle 默认只管理 `public`，结构上够不着；schema 由启动流程的 `ensureFedifySchema()` 幂等创建），另在 [drizzle.config.ts](../packages/hono-server/drizzle.config.ts) 保留 `tablesFilter` 作第二道防线。
  - **已上线（2026-09-21）**：新镜像部署完成，`migrate` 退出码 0 且**零数据丢失提示**，`server` 日志出现 `[Fedify] schema ready`；`public` 下的两张残留空表已 DROP；在 server 容器内实测 KV 读写往返成功、表落在 `fedify.fedify_kv_v2`。
  - 部署时顺带发现：**服务器上的 `docker-compose.prod.yml` 一直没跟上「改用 ghcr」那次提交**（仍是本地镜像名 `rssfed-server:latest`），因此那次改动从未在线上生效过。本次已用仓库版本覆盖（旧版备份为 `docker-compose.prod.yml.bak.<时间戳>`）。ghcr 包改为 public 的坑见 [docker-deployment.md](docker-deployment.md) 第 10 节。
- `push` 只对齐结构、不回填数据；新增非空列之类改动需手动补数据。

### 11. 运行时与资源 ✅

`sharp` 是原生依赖，镜像构建与运行平台一致（`linux/amd64`、`linux/arm64` 均可）；Redis 是 BullMQ 硬依赖，编排里已带 `--appendonly yes`。抓取 + AVIF 压缩与 API 抢 CPU/内存，建议 2 核 4GB 起步。

### 12. 日志 ⚠️

compose 层已统一配 `json-file` 轮转（单文件 10MB × 3），Caddy 访问日志走 stdout。**应用仍是 `console.log`**，未结构化、未接集中收集。云端需要的话改 `x-logging` 锚点或接 Loki/CloudWatch。

### 13. CI/CD ⚠️

- **已做**：[ci.yml](../.github/workflows/ci.yml) 新增 `docker` job，用 buildx + GHA 缓存并行验证 `server`、`web` 两个 target 可构建（`push: false`），源码或 Dockerfile 改动导致构建失败会在 CI 挡住；同时补上根 `package.json` 的 `packageManager`（原先 `pnpm/action-setup@v4` 找不到版本会直接失败）并把安装改为 `--frozen-lockfile`。
- **未做**：构建推送镜像到 registry、部署流水线（按需再接）。

## P2 · 卫生与文档

### 14. 清理模板残留 ✅

已删除 `packages/nuxt-client` 下 Nuxt UI starter 的残留：嵌套 `.github/workflows/ci.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（其 `allowBuilds` 还是占位文本 `set this to true or false`，会让在该目录执行的 pnpm 命令认错 workspace 根）、`renovate.json`、`README.md`，以及版权方为 "Nuxt UI Templates" 的 `LICENSE`。

> ⚠️ 现在仓库**没有任何 LICENSE 文件**。仓库根目录没有许可证声明，如果需要请自行新增一份（不要把模板那份当项目许可）。

### 15. 更正 ARCHITECTURE 部署章节 ✅

[ARCHITECTURE.md](../ARCHITECTURE.md#L137) 的部署架构已重写：补全联邦与 MCP 路径的分流规则，并纠正「开发模式下 Nuxt 通过 Nitro middleware 代理 `/api/*`」这一与实现不符的描述（前端是直连后端）。

### 16. 新增部署文档 ✅

[docs/docker-deployment.md](docker-deployment.md)：快速开始、镜像说明（含实测体积与取舍）、路由规则、环境变量、数据库变更、运维备注、其他部署形态。

## 部署当天执行顺序

> ✅ 已于 2026-09-20 在真实云主机上完整执行（实例信息见文末「当前部署实例」）。

1. 起依赖服务（PG / CouchDB / Redis / S3），等 healthcheck 全绿
2. `migrate` 自动执行 `drizzle-kit push`（首次可直接 `--force`）
3. 起后端，确认日志出现 `[CouchDB Config] proxy auth configured`
4. 起前端
5. 起反代（该机器已有宿主机 Caddy 在服务其他站点，故未用 compose 的 `--profile tls`）
6. 跑下方上线验收清单

## 待决策

- [x] 目标平台：单机 Docker Compose（自建依赖容器）
- [x] 域名：生产实例使用自有域名的子域（主域已用于 VitePress 站点）；**具体域名与公网 IP 不记录在本仓库**
- [x] 依赖服务：compose 内置（已支持随时切托管：设 `DATABASE_URL` / `COUCHDB_URL` / `REDIS_HOST` 即可）
- [x] 前端形态：Nuxt SSR（当前）

## 本地端到端验收（2026-09-21）

> 环境：本机开发栈（Hono :3001 / Nuxt :3000 + compose 的 PG / CouchDB / Redis / RSSHub）。
> 用 HTTP 层覆盖所有能在服务端判定的项；需要真实浏览器 IndexedDB 与公网域名的项仍留空。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 注册 / 登录 / 刷新后登录态保持 | ✅ | 注册 200 → cookie 落盘 → 带 cookie `get-session` 200，`expiresAt` 为 7 天后 |
| 添加订阅源 → 抓取 → 条目入库 | ✅ | `discover` 解析出 10 条；`feed_*` 库落 12 docs（1 FeedDoc + 10 EntryDoc + 1 design）；`/api/feeds/subscriptions` 返回 `status: active` 且 `lastFetchedAt` / `lastNewEntryAt` 同步刷新 |
| PouchDB 同步（服务端协议侧） | ✅ | `_changes?feed=longpoll` 返回变更流、`_bulk_docs` 201、`_revs_diff` 200 —— 已读/收藏可双向同步 |
| webfinger 返回正确 actor | ✅ | `acct:acceptancebot@localhost:3001` → 200，subject 与 self 链接正确。注意 resource 的域必须与请求 Host 严格一致：本地裸写 `@localhost`（不带端口）会 404，属正常行为而非缺陷 |
| bot 创建 + actor 文档 | ✅ | `POST /api/bots` 201；`/ap/actor/acceptancebot` 返回完整 ActivityStreams 文档 |
| 图片附件可访问 | 未复验 | 2026-09-20 已端到端验过（见「已就绪」） |
| PouchDB 断网可读（IndexedDB 层） | 未验 | 本机无 Chrome，playwright 安装被沙箱拦在 `~/.cache`，需人工在浏览器验证 |
| 备份任务 + 恢复演练 | ❌ | 见 P1 §9：仓库零实现 |
| 从 Mastodon 关注 bot 并收到推送 | 被阻断 | 本地实测反代漏放行 `/ap/*`（见下），修复后需在公网重验 |

### 本轮修复：反代漏放行 `/ap/*`（曾使联邦整体不可用）

**现象**：`/ap/actor/{username}` 返回 404。

**根因**：[../deploy/Caddyfile](../deploy/Caddyfile) 的后端 matcher 只放行了 `/users/*`，但 BotKit 的 actor 实际路径是 **`/ap/actor/{username}`**，而 `/users/*` 在后端根本不存在（实测 404）。

**为什么极难发现**：webfinger 走 `/.well-known/*`，那条是被正确放行的，所以它照常返回 200；Mastodon 据此拿到 actor URL 后回来取，才落到 Nuxt 上 404。外部表现是「能搜到账号、但无法关注 / 账号加载不出来」，同时站点首页完全正常。Caddyfile 注释里恰好警告过这一类坑，而那份 matcher 恰好漏了它。

**实测对照**（起临时 Caddy，上游指向本地服务）：

| 路径 | 修复前 | 修复后 |
| --- | --- | --- |
| `/ap/actor/acceptancebot` | 404 | 200 |
| `/@acceptancebot` | 404 | 200 |
| `/.well-known/webfinger` | 200 | 200 |
| `/login`（确认未误伤 Nuxt 路由） | 200 | 200 |
| `/admin/queues`（屏蔽仍生效） | 404 | 404 |

**修复**：matcher 补 `/ap/*` 与 `/@*`，并补上注释与实测路径清单；`caddy validate` 通过。

### 线上修复（2026-09-21，已完成）

线上用的是**宿主机已有的 Caddy**（`rssfed.uvcat.cn` 站点段手工追加，不在本仓库），已同步修改并 reload：

- 改前：`@backend path /api/* /mcp /mcp/* /.well-known/* /nodeinfo/* /users/* /inbox /inbox/*`
- 改后：补入 `/ap/*` 与 `/@*`；改动前已备份到 `/etc/caddy/Caddyfile.bak.rssfed.<时间戳>`
- `sudo caddy validate` → `Valid configuration`，`sudo systemctl reload caddy` 成功

**公网复验**（修复前 → 修复后）：

| 路径 | 修复前 | 修复后 |
| --- | --- | --- |
| `/ap/actor/<名>` | 404 + `application/json`，Nuxt 的 `"Page not found"` | 404 + `text/plain`，Fedify 的 `Not Found`（实体不存在，但**路由已通**） |
| `/@<名>` | Nuxt 404 JSON | Fedify `text/plain` 404 |
| `/ap/actor/<名>/outbox` | — | Fedify 应答 |
| `/api/health`、`/login`、首页 | 200 | 200 |
| `/admin/queues` | 404 | 404 |

> **判定依据**：Nuxt 的 404 是 JSON（含 `statusCode` / `statusMessage`），Fedify 的 404 是 `text/plain`。响应形态的变化即证明请求已从 Nuxt 切到后端。生产联邦地址正确：`PUBLIC_URL=https://rssfed.uvcat.cn` 由 compose 派生出 `BOTS_BASE_URL`。
>
> **端到端复验（临时 bot，验完即删）**：生产库此前 `bots` 为 0 行（users 1、feeds 12）—— 该实例从未创建过 bot，联邦链路从未被真正走通，这正是缺陷长期未被发现的原因。为验证修复，临时创建了一个 bot（挂到现有管理员账号下）实测：
>
> | 检查 | 结果 |
> | --- | --- |
> | `webfinger?resource=acct:<bot>@rssfed.uvcat.cn` | 200，subject 正确，self 指向 `/ap/actor/<bot>` |
> | `/ap/actor/<bot>`（`Accept: application/activity+json`） | **200**，`application/activity+json`；`type=Service`、`inbox`/`outbox`/`followers` 齐全、**含 `publicKey`** |
> | `/@<bot>`（profile 页） | 200 |
> | `/ap/actor/<bot>/outbox` | 200 |
> | `POST /ap/actor/<bot>/inbox`（无签名空投递） | 400 `Missing actor.`（**非 404**，说明 inbox 路由已可达并被 Fedify 处理） |
>
> 验证完成后已删除该临时行，`bots` 回到 0 行，webfinger / actor 均恢复 404 —— 数据库状态与验收前一致，本次线上只留下了 Caddyfile 一处改动（且有备份）。
>
> 至此「能不能被 fediverse 关注」的技术前提已全部满足：**发现（webfinger）→ 取 actor（含公钥）→ 投递（inbox）** 三条链路均通。

## 上线验收清单

> 自动化部分已验证；标注「待人工验证」的需要在浏览器里操作。2026-09-21 的本地端到端结果见上一节，本节保留公网验收口径。

- [x] 公网 HTTPS 可访问首页 —— 200，证书由宿主机 Caddy 自动签发
- [x] 注册/登录成功，刷新后登录态保持（cookie 正常）—— ✅ 2026-09-21 本地验收：session cookie 有效期 7 天，刷新后 `get-session` 200；公网待人工复验
- [x] 添加一个订阅源，抓取成功并能在时间线看到条目 —— ✅ 2026-09-21 本地验收：解析 10 条并入库，`lastFetchedAt` / `lastNewEntryAt` 刷新；前端渲染待人工复验
- [ ] PouchDB 离线同步正常（断网可读缓存条目）—— 服务端同步协议已验（`_changes` 长轮询 / `_bulk_docs` / `_revs_diff`），浏览器 IndexedDB 层**待人工验证**
- [x] 图片附件可访问 —— 本地文件存储端到端实测：上传头像 → 落盘到 `uploads-data` 卷 → `/api/files/*` 读回 200（`image/png`）
- [x] `/.well-known/webfinger` 返回正确 actor —— ✅ 2026-09-21 本地验收：创建 bot 后返回 200 与正确 subject / self 链接（resource 的域须与请求 Host 一致）
- [ ] 从 Mastodon 等实例搜索并关注 bot，能收到推送 —— 反代缺陷已修，且**技术前提已在公网全部验证通过**（webfinger 200 / actor 200 含 `publicKey` / inbox 可达，见「线上修复」一节）。**仅剩实际交互待人工**：在自己的 fediverse 账号里搜索并关注 bot，确认能收到推送
- [x] MCP 客户端用 token 连上 `/mcp` —— 无 token 时 401，路由正常（非 3xx）
- [x] `/admin/queues` 未登录返回 401 —— 公网实测 404（反代层已屏蔽）
- [ ] 备份任务已配置并验证过一次恢复 —— ❌ 2026-09-21 核实：全仓库 grep `pg_dump` / `pg_restore` / `backup` / `备份` 零命中，无任何备份脚本或定时任务

## 当前部署实例

> 具体域名、公网 IP 等运行环境信息**不记录在本仓库** —— 它们写在服务器 `~/rssfed/.env.production` 的头部注释里（该文件权限 600、不入库）。本节只保留换机器或重装时仍然有用的知识。

本次部署遇到的限制与结论：

- `github.com` 的 HTTPS 与 Docker Hub 直连都超时（国内云主机常见）；GitHub **SSH(22) 可用**，镜像拉取依赖容器运行时已配置的内网加速源。换机器时先确认这两条通路，否则会卡在构建阶段。
- 内存只有 2G 左右，容器内构建 Nuxt 极易 OOM，因此镜像改由 **CI 构建并推送到 ghcr**，服务器只 `compose pull` 拉取运行（见 [docker-deployment.md](docker-deployment.md) 第 10 节）。
- 反代复用宿主机已有的 Caddy：只在其配置**末尾追加**一个站点段，不动既有站点；TLS 由 Caddy 自动签发。

与具体环境无关的部署形态：

| 项 | 值 |
| --- | --- |
| 部署目录 | `~/rssfed/`：`docker-compose.prod.yml` + `.env.production`（权限 600），无需完整源码 |
| 镜像来源 | CI（GitHub Actions）构建并推送到 ghcr，服务器 `compose pull` 拉取；本地构建仅用于开发 |
| 文件存储 | `STORAGE_DRIVER=fs`，数据在 `uploads-data` 卷（`/app/data/uploads`），附件走 `/api/files/*` 代理；SeaweedFS 保留为可选（`--profile s3`） |
| 启动方式 | `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build` |
| 资源占用 | 上线后实测内存约 900Mi（5 个容器） |

### 未实现：nodeinfo

原评估认为 `/nodeinfo/2.1` 由 Fedify 提供，实际代码中没有注册 nodeinfo dispatcher，该路径返回 404。这是代码层缺失，**不是部署问题**；联邦功能（webfinger / actor / inbox）不依赖 nodeinfo。要做的话需在 BotKit/Fedify 实例上加 `setNodeInfoDispatcher`。

- **补充实测（2026-09-21）**：`/.well-known/nodeinfo` 返回 200，但内容为 `{"links":[]}`（发现文档存在却无任何 link）；`/nodeinfo/2.0` 与 `/nodeinfo/2.1` 均 404 —— 与「dispatcher 未注册」一致。反代已放行 `/nodeinfo/*`，补上 dispatcher 后无需再改 Caddy。
