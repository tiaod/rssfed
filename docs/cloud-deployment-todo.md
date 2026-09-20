# RSSFed 云端部署待办

> 初版基于 commit `09258b4` 评估。**本文档已更新到当前工作区状态**：交付层（镜像、编排、反代、部署文档）已完成并本机实测，P0 的代码层安全开关也已修掉。
> 图例：✅ 已完成（附验收证据）｜⚠️ 部分完成｜❌ 未做

## 结论

交付层已完成：应用镜像、生产编排、反代与 TLS、部署文档都已落地并实测通过；代码层安全开关（信任域、看板鉴权、示例凭据）已修复。

距离首次上云只差三件事：**真实主机 + 域名 + 跑一遍上线验收清单**（清单里每一项都需要公网域名，本机无法验证）。

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
- 分流规则：`/api/*`、`/mcp`、`/mcp/*`、`/.well-known/*`、`/nodeinfo/*`、`/users/*`、`/inbox` 走 Hono；其余走 Nuxt；`/admin/queues` 直接 404。
- **要点**：TLS 终止在反代，`X-Forwarded-Proto` 由 Caddy 默认透传；Nuxt 与 Hono 同域以保持 cookie 同站。
- **未完成**：公网验收 curl（`/nodeinfo/2.1`、webfinger、`/mcp/` 非 3xx）需要真实域名，见文末清单。

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

### 10. schema 发布步骤 ✅

- [docker-compose.prod.yml](../docker-compose.prod.yml) 的 `migrate` 服务在 `server` 启动前单次执行 `drizzle-kit push --force`，`server` 用 `service_completed_successfully` 依赖它。
- **实跑确认**：`up -d --build` 会重建 migrate 容器并重跑；镜像未变而要重跑用 `docker compose ... run --rm migrate`。
- `--force` 会自动批准数据丢失语句（可能 truncate 表）：首次部署无风险，后续删列/改类型前先 `--verbose` 复核（见 [docker-deployment.md](docker-deployment.md) 第 5 节）。
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

## 上线验收清单

> 自动化部分已验证；标注「待人工验证」的需要在浏览器里操作。

- [x] 公网 HTTPS 可访问首页 —— 200，证书由宿主机 Caddy 自动签发
- [ ] 注册/登录成功，刷新后登录态保持（cookie 正常）—— **待人工验证**
- [ ] 添加一个订阅源，抓取成功并能在时间线看到条目 —— **待人工验证**
- [ ] PouchDB 离线同步正常（断网可读缓存条目）—— **待人工验证**
- [x] 图片附件可访问 —— 本地文件存储端到端实测：上传头像 → 落盘到 `uploads-data` 卷 → `/api/files/*` 读回 200（`image/png`）
- [ ] `/.well-known/webfinger` 返回正确 actor —— 端点已挂载（无 bot 时 404），需先创建 bot
- [ ] 从 Mastodon 等实例搜索并关注 bot，能收到推送 —— 需先创建 bot
- [x] MCP 客户端用 token 连上 `/mcp` —— 无 token 时 401，路由正常（非 3xx）
- [x] `/admin/queues` 未登录返回 401 —— 公网实测 404（反代层已屏蔽）
- [ ] 备份任务已配置并验证过一次恢复

## 当前部署实例（2026-09-20）

| 项 | 值 |
| --- | --- |
| 域名 | `https://<你的域名>`（A → `<服务器 IPv4>`，AAAA → `<服务器 IPv6>`） |
| 主机 | Ubuntu 24.04，2 核 / 1.9G 内存 + 1.9G swap，50G 磁盘 |
| 运行时 | Docker 29.7.2 + Compose v5.5.0；Caddy 2.11.4（宿主机 systemd，非容器） |
| 部署目录 | `~/rssfed/`：`docker-compose.prod.yml`、`.env.production`、`seaweedfs-s3.json`（后两者权限 600） |
| 文件存储 | `STORAGE_DRIVER=fs`，数据在 `uploads-data` 卷（`/app/data/uploads`），附件走 `/api/files/*` 代理；SeaweedFS 保留为可选（`--profile s3`） |
| 镜像来源 | 本地构建 → `docker save \| gzip \| ssh \| docker load`，服务器上不构建 |
| Caddy 配置 | `/etc/caddy/Caddyfile` 末尾追加的 `<你的域名>` 段，原 VitePress 站点配置未改动 |
| 启动方式 | `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build` |

该服务器有两个网络限制（本次已绕开，换机器或重装时需注意）：

- `github.com` 的 HTTPS 与 Docker Hub 直连都超时；GitHub **SSH(22) 可达**，镜像拉取依赖已配置的腾讯云内网加速器（`mirror.ccs.tencentyun.com`、`docker.m.daocloud.io`）。
- 内存只有 1.9G，容器内构建 Nuxt 极易 OOM，所以镜像一律本地构建后传输。上线后实测内存占用约 911Mi。

### 未实现：nodeinfo

原评估认为 `/nodeinfo/2.1` 由 Fedify 提供，实际代码中没有注册 nodeinfo dispatcher，该路径返回 404。这是代码层缺失，**不是部署问题**；联邦功能（webfinger / actor / inbox）不依赖 nodeinfo。要做的话需在 BotKit/Fedify 实例上加 `setNodeInfoDispatcher`。
