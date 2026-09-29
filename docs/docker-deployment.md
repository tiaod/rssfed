# Docker 部署指南

把 RSSFed 部署到一台装了 Docker 的云主机上。整套编排包含应用（Nuxt 前端 + Hono 后端）和三个依赖服务（PostgreSQL / CouchDB / Redis）。

相关文件：

| 文件 | 作用 |
| --- | --- |
| [Dockerfile](../Dockerfile) | 多 target 镜像定义：`server` / `web` / `migrate` / `prod-deps` |
| [.dockerignore](../.dockerignore) | 构建上下文瘦身 + 阻止 `.env`、`node_modules` 进镜像 |
| [docker-compose.prod.yml](../docker-compose.prod.yml) | 生产编排：应用 + 依赖 + 可选 Caddy |
| [.env.production.example](../.env.production.example) | 环境变量模板 |
| [deploy/Caddyfile](../deploy/Caddyfile) | 反向代理与 TLS（按路径分流到前端/后端） |

> 这是单机 Docker Compose 方案。托管数据库、K8s、PaaS 平台请看文末「其他部署形态」。

## 1. 快速开始

前提：云主机已装 Docker（含 compose 插件），域名已解析到该主机，且 80/443 对公网开放。

```bash
git clone <repo> rssfed && cd rssfed

# 1) 准备环境变量：填 PUBLIC_URL 和 4 个密钥
cp .env.production.example .env.production
openssl rand -hex 32   # 生成 POSTGRES_PASSWORD / COUCHDB_PASSWORD / BETTER_AUTH_SECRET
openssl rand -hex 16   # 生成 COUCHDB_PROXY_SECRET（生成一次后不要再改）
vim .env.production

# 2) 拉取镜像并启动（镜像由 CI 构建推送到 ghcr，见第 10 节）
#    --profile tls 会额外拉起 Caddy 自动申请 HTTPS 证书
docker compose --env-file .env.production -f docker-compose.prod.yml --profile tls up -d
```

启动顺序由编排保证：`postgres`/`couchdb`/`redis` 健康 → `migrate` 对齐表结构 → `server` → `web` → `caddy`。

验证：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl -s https://<你的域名>/api/health          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://<你的域名>/.well-known/nodeinfo  # 200 即联邦端点可达（当前 links 为空，见 troubleshooting）
```

首屏可用后，用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 引导创建的管理员账号登录（见 [.env.production.example](../.env.production.example)），或在站点注册首个账号。

## 2. 镜像说明

单 Dockerfile 四个 target：

| target | 内容 | 大小（本机实测） | 说明 |
| --- | --- | --- | --- |
| `builder` | 全量 devDependencies + 两个应用的构建产物 | — | 仅构建期使用，不进最终镜像 |
| `server` | `esbuild` 打包后的后端单文件 + production 依赖 | 729 MB | API + ActivityPub + BullMQ worker 同进程；其中 403 MB 是 production 依赖 |
| `web` | Nuxt `.output`（自包含） | 267 MB | 应用本体只占 24 MB，其余是 Node 基础镜像 |
| `migrate` | `builder` + `drizzle-kit` | 1.26 GB | 一次性任务，跑 `drizzle-kit push --force`，跑完即退出 |
| `prod-deps` | 只装 `@rssfed/hono-server` 的 production 依赖 | — | 供 `server` 拷贝 |

体积主要来自 Node 基础镜像和 production 依赖，已做的取舍：

- 运行镜像用 `node:22-alpine`（musl），实测比 `bookworm-slim` 各小约 90 MB。若要 glibc 版本（例如自建原生模块），把 Dockerfile 里的 `-alpine` 换成 `-bookworm-slim` 即可。
- 依赖无法再显著精简：`better-auth` 的 peerDependencies 会让 pnpm 自动装上 `vitest`、`typescript`、`happy-dom` 等约 100 MB 的包（pnpm 的 `auto-install-peers` 默认行为）。想再压体积可以试 `pnpm install --config.auto-install-peers=false`，但需自行验证登录等依赖 better-auth 的接口，不建议首次部署就动。
- `sharp`（AVIF 压缩）走预编译二进制，musl 与 glibc 都有对应包，`linux/amd64` 与 `linux/arm64` 均可。跨架构构建请用 `docker buildx build --platform linux/amd64`，构建平台与运行平台保持一致。
- **非 root 运行**：`server`/`web` 都以镜像自带的 `node` 用户启动。
- **健康检查**：镜像内置 `HEALTHCHECK`（后端 `/api/health`，前端 `/`），编排可直接依赖。

本机实测通过的行为（`node:22-alpine` 构建）：

- `server` 容器启动、`/api/health` 返回 200、容器状态 healthy；
- `sharp` 实际编码 AVIF 成功（musl libvips 可用，非仅 `import` 通过）；
- `dotenv` / `@bull-board/hono` 等运行时依赖可加载；
- `web` 容器启动、SSR 首页返回 200；
- 全栈编排：五个服务全部 healthy，`migrate` 建出 13 张表，server 日志出现 `[CouchDB Config] proxy auth configured` 且 CouchDB `_users` 库自动创建。

几个关键设计：

- **后端为什么用 esbuild 打包**：`tsconfig` 是 `moduleResolution: bundler`，源码里的相对导入不带扩展名，`tsc` 产出的 `dist/index.js` 无法被 Node ESM 直接执行（`ERR_MODULE_NOT_FOUND`）。`build:bundle` 用 esbuild 把本地源码内联成单文件，第三方依赖保持 external。
- **依赖分层**：`drizzle-kit`、`typescript`、`vitest` 等 devDependencies 只出现在 `builder`/`migrate`，`server` 镜像只装 production 依赖，且用 `--filter` 限定只装后端，不会把 Nuxt 的一堆依赖带进来。

单独构建某个镜像：

```bash
docker build --target server -t rssfed-server:latest .
docker build --target web    -t rssfed-web:latest    .
```

## 3. 反向代理与路由

前端和后端**同域**部署（cookie 同站，见 [ARCHITECTURE.md](../ARCHITECTURE.md)），由反向代理按路径分流。规则见 [deploy/Caddyfile](../deploy/Caddyfile)：

| 路径 | 去向 |
| --- | --- |
| `/api/*` | server（含 `/api/health`、`/api/couchdb` 代理、`/api/files/*`） |
| `/api/site-settings/*` | server —— 上面一条已覆盖。**PWA 的 Manifest 与图标也在这里**（`/api/site-settings/manifest.webmanifest`、`/api/site-settings/icon/*`），因此反代无需为 PWA 追加任何规则；注意它们必须是**同源**路径，不要改挂到域名根下 |
| `/mcp`、`/mcp/*` | server，**不做 301/307**（重定向会让 MCP 客户端丢掉 `Authorization` 头） |
| `/.well-known/*` | server（webfinger） |
| `/nodeinfo/*` | server |
| `/ap/*` | server（**BotKit actor / inbox / outbox —— 真实路径是 `/ap/actor/{username}`**） |
| `/@*` | server（actor 的 profile 页） |
| `/users/*`、`/inbox` | server（Fedify 默认路由与共享 inbox，当前未启用，实测 404） |
| `/admin/queues` | 反代直接 404（队列看板不对外） |
| 其余 `/` | web（Nuxt SSR） |

**只转 `/api/*` 是最常见的踩坑**：ActivityPub 端点挂在 Hono 的 `app.all("*")` 兜底上，漏了 `/mcp`、`/.well-known/*`、`/ap/*` 会让联邦与 MCP 整体 404。

其中 **`/ap/*` 最阴**：webfinger 走 `/.well-known/*`，能正常返回 200；外部实例据此拿到 `/ap/actor/{username}` 再回来取时才发现 404，外部表现为「能搜到账号、但无法关注 / 账号加载不出来」，而站点首页完全正常。2026-09-21 上线验收实测踩过这个坑，详见 [cloud-deployment-todo.md](cloud-deployment-todo.md) 的「本地端到端验收」一节。

用自建 Nginx / 云负载均衡代替 Caddy 时，对照上表配置，并把上游指向宿主的 `127.0.0.1:3000`（web）与 `127.0.0.1:3001`（server）——compose 默认只把这两个端口绑到回环，公网直连不到。此时不要加 `--profile tls`，避免 80/443 冲突。

Caddy 的两种用法（[deploy/Caddyfile](../deploy/Caddyfile) 已按上表写好，`caddy validate` 实测通过）：

- **编排内置 Caddy（推荐）**：启动时加 `--profile tls`，站点地址取自 `PUBLIC_URL`，证书自动申请续期，`ACME_EMAIL` 可填证书到期通知邮箱。
- **宿主机自建 Caddy**：把 Caddyfile 里的 `server:3001`、`web:3000` 改成 `127.0.0.1:3001`、`127.0.0.1:3000`，并且不要加 `--profile tls`。
- 改完配置热加载：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

Caddyfile 里还留了几处按需开关（都是注释形式）：访问日志按大小切割成文件、Caddy 前面还有云负载均衡时的 `trusted_proxies`、多域名或带 `www` 的写法。

上线验收（应全部符合预期）：

```bash
BASE=https://<域名>
curl -s $BASE/api/health
curl -s -o /dev/null -w '%{http_code}\n' $BASE/.well-known/nodeinfo   # 200：联邦端点可达
curl -s "$BASE/.well-known/webfinger?resource=acct:<bot名>@<域名>"    # 返回 subject 与 actor 链接
# 下面这条最关键：webfinger 通了不代表 actor 取得回来。
# 反代若漏放行 /ap/*，这里会落到 Nuxt 上返回 404（JSON 形如 {"statusCode":404,...}）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' \
  "$BASE/ap/actor/<bot名>"                                            # 必须是 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/mcp/                   # 不能是 3xx
```

> `/ap/actor/{username}` 是 BotKit actor 的真实路径，**不是 `/users/*`**。2026-09-21 上线验收正是漏了这一条：webfinger 返回 200、首页正常，但 actor 一律 404，联邦功能整体不可用。详见 [cloud-deployment-todo.md](cloud-deployment-todo.md) 的「本地端到端验收」。

## 4. 环境变量

全部变量见 [.env.production.example](../.env.production.example)，其中**必填**的只有五项：

| 变量 | 说明 |
| --- | --- |
| `PUBLIC_URL` | 对外地址，含协议、不带结尾斜杠。同时作为 `BETTER_AUTH_URL` / `BOTS_BASE_URL` / `CORS_ORIGINS` 和前端 API 基址 |
| `POSTGRES_PASSWORD` | 内置 PostgreSQL 口令 |
| `COUCHDB_PASSWORD` | CouchDB 管理员口令 |
| `COUCHDB_PROXY_SECRET` | CouchDB 代理认证共享密钥，**必须固定**，每次重启都变会导致代理认证失效 |
| `BETTER_AUTH_SECRET` | better-auth 会话签名密钥 |

`PUBLIC_URL` 是 ActivityPub actor ID 的 origin，**上线后修改会让已关注的远端实例失联**，请在第一次启动前确定。

`COUCHDB_USER` 默认 `admin`，编排会把同一个值同时传给 CouchDB 容器和 server 容器：server 启动时需要管理员凭证写入 CouchDB 的 proxy auth 配置，两边用户名必须一致（密码同理，都取自 `COUCHDB_PASSWORD`）。若看到 `Failed to configure CouchDB proxy auth: You are not a server admin`，就是这两个值对不上。

依赖地址默认指向 compose 内置服务（容器网络内）。要用托管 PostgreSQL / CouchDB / Redis，在 `.env.production` 里设置 `DATABASE_URL` / `COUCHDB_URL` / `REDIS_HOST`，`server` 服务会自动优先使用这些值，内置依赖服务可以整个删掉。

## 5. 数据库变更

编排里的 `migrate` 服务执行一次 `drizzle-kit push --force`，成功后才启动 `server`（`depends_on: service_completed_successfully`）。什么时候会跑：

- 常规发布 `up -d --build` 时会重建镜像，`migrate` 容器随之重建并重新执行，不用手动干预；
- 镜像没变却想重跑（例如只改了数据库地址），显式执行：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
```

`--force` 的语义是**自动批准数据丢失语句**（可能 truncate 表），首次部署无风险，后续涉及删列/改类型时先复核再落地：

```bash
# 预览将要执行的语句（不要加 --force）
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate \
  pnpm exec drizzle-kit push --verbose
```

## 6. 运维备注

- **部署目录要带 `deploy/`**：compose 会挂载 `deploy/couchdb-proxy-auth.ini` 到 CouchDB 的 `local.d/`（缺了它 CouchDB 不会挂载 proxy 认证 handler，`/api/couchdb/proxy/*` 全部 401，前端看不到订阅内容，见 [troubleshooting](troubleshooting.md)）。手工同步文件的部署方式（只 scp `docker-compose.prod.yml` + `.env.production`）必须连 `deploy/` 目录一起传，否则容器起不来或功能残缺。注意这个挂载**不能加 `:ro`**（entrypoint 会 chown，只读挂载会让容器无日志 exit 1），而且容器首次启动后宿主机的该文件属主会变成 `couchdb(5984)`，后续更新它要用 `sudo`。
- **单副本**：抓取调度与 BotKit 轮询是进程内 `setInterval`，worker 与 API 同进程。`server` 不要 `--scale` 超过 1，否则会重复入队、重复发布 ActivityPub 活动。
- **持久化**：`postgres-data`、`couchdb-data`、`redis-data`、`seaweedfs-data`、`caddy-data` 五个命名卷必须纳入备份。CouchDB 每个订阅源一个库，是数据主体，别只备份 PostgreSQL；`seaweedfs-data` 存的是正文图片与头像附件。
- **日志**：compose 里统一配了 `json-file` 轮转（单文件 10MB × 3）。要集中收集就改 `x-logging` 锚点，或把 `docker logs` 接到 Loki/CloudWatch。
- **更新发布**：push 到 master 后 CI 构建并推送镜像，然后在服务器执行 `docker compose --env-file .env.production -f docker-compose.prod.yml pull && docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build` —— 镜像没变时 `up -d` 不会重建容器，变了则会先跑 migrate 再滚动应用。回滚方式见第 10 节。
- **构建缓存**：镜像分层与 pnpm store 都走 BuildKit 缓存，首次构建后再次构建很快。缓存占用的磁盘可用 `docker builder prune` 回收（代价是下次构建重新下载依赖）。
- **资源**：抓取 + AVIF 压缩与 API 抢 CPU/内存，2 核 4GB 起步；抓取量大时优先把 worker 拆成独立进程。

## 7. 代码层生产开关（已完成）

以下三项属于代码层，已在 [cloud-deployment-todo.md](cloud-deployment-todo.md) 的 P0-5/P0-6 修复并实测（恶意 Origin 403、看板未登录 401）：

- [auth.ts](../packages/hono-server/src/auth.ts) 的 `trustedOrigins` 生产环境只认 `CORS_ORIGINS` 白名单，开发环境才放开通配。
- [config.ts](../packages/hono-server/src/config.ts) 的 `isOriginAllowed` 仅在非生产放行 localhost 与私有网段。
- `/admin/queues` 由 [require-admin.ts](../packages/hono-server/src/middleware/require-admin.ts) 强制管理员校验，Caddyfile 里另有一层 404 屏蔽。

## 8. 其他部署形态

- **托管依赖 + 应用容器**：删掉 compose 里的 `postgres`/`couchdb`/`redis` 服务，把 `DATABASE_URL` 等指向托管实例，只跑 `migrate` + `server` + `web`。
- **PaaS（Railway / Fly.io / Render）**：分别部署两个镜像（`--target server`、`--target web`），环境变量按第 4 节配置；注意这些平台要单独跑一次 `migrate`（可作为 release/pre-deploy 命令）。
- **K8s**：`server` 用 Deployment（`replicas: 1`）+ 单次 Job 跑 migrate，`web` 可多副本，Ingress 按第 3 节路径分流。

## 9. 文件存储（本地文件或 S3）

头像、Bot 头像、站点 logo 走存储后端；**正文图片不走这里** —— 它们在抓取时压成 AVIF，作为 CouchDB 附件保存（这也是启动时把 CouchDB 附件上限放宽到 8MB 的原因）。

两个后端由 `STORAGE_DRIVER` 选择，对 key 的语义完全一致，可随时切换：

| 后端 | 适用场景 | 关键配置 |
| --- | --- | --- |
| `fs` | 图片量小，不想多养一个服务 | `STORAGE_DRIVER=fs` + `STORAGE_FS_DIR=/app/data/uploads`，数据在 `uploads-data` 卷 |
| `s3`（默认值） | 图片多要挂 CDN，或改用云对象存储 | `STORAGE_S3_*`；用编排里的 SeaweedFS 还要 `--profile s3` |

两者 `getPublicUrl` 的行为一致：配了公开域名就返回直链，否则返回 `undefined`，调用方回退到本服务的 `/api/files/*` 代理。

### fs 后端（默认推荐给单机小规模）

```bash
# .env.production
STORAGE_DRIVER=fs
STORAGE_FS_DIR=/app/data/uploads
# 可选：配置后附件 URL 直指该域名，否则走 /api/files/* 代理
# STORAGE_FS_PUBLIC_DOMAIN=https://cdn.example.com
```

不需要额外服务。数据落在 `uploads-data` 卷里，**备份与迁移时别漏了它**。改完要重建 server 容器生效：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build server
```

### s3 后端

```bash
# 1) 生成凭据（accessKey/secretKey 要与 .env.production 里填的一致）
AK=$(openssl rand -hex 12); SK=$(openssl rand -hex 24)
cat > ~/rssfed/seaweedfs-s3.json <<EOF
{ "identities": [ { "name": "rssfed-prod",
    "credentials": [ { "accessKey": "$AK", "secretKey": "$SK" } ],
    "actions": ["Read","Write","List","Tagging","Admin"] } ] }
EOF
chmod 600 ~/rssfed/seaweedfs-s3.json

# 2) .env.production 指向 compose 服务名（不是 localhost）
#    STORAGE_DRIVER=s3
#    STORAGE_S3_ENDPOINT=http://seaweedfs:8333
#    STORAGE_S3_REGION=us-east-1
#    STORAGE_S3_ACCESS_KEY_ID=$AK
#    STORAGE_S3_SECRET_ACCESS_KEY=$SK
#    STORAGE_S3_BUCKET=rssfed
#    STORAGE_S3_FORCE_PATH_STYLE=true

# 3) SeaweedFS 默认不启动，需要显式带上 profile
docker compose --env-file .env.production -f docker-compose.prod.yml --profile s3 up -d --no-build seaweedfs
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build server

# 4) 建 bucket —— 应用不会自动创建，缺了它上传会报 NoSuchBucket
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T \
  -w /app/packages/hono-server server node --input-type=module -e '
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
const c = new S3Client({ endpoint: process.env.STORAGE_S3_ENDPOINT, region: process.env.STORAGE_S3_REGION,
  credentials: { accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY },
  forcePathStyle: true });
await c.send(new CreateBucketCommand({ Bucket: process.env.STORAGE_S3_BUCKET }));
console.log("bucket ready");
'
```

排障：用未签名请求探测 SeaweedFS 的 S3 端口会返回 403 `AccessDenied` —— 这说明服务在正常监听，不是故障。

## 10. 镜像仓库与 CI/CD

镜像由 GitHub Actions 构建并推送到 **GitHub Container Registry**（[build-images.yml](../.github/workflows/build-images.yml)，push `master` 触发）：

| 镜像 | 用途 |
| --- | --- |
| `ghcr.io/tiaod/rssfed/server` | 后端（API + ActivityPub + worker） |
| `ghcr.io/tiaod/rssfed/web` | 前端（Nuxt SSR） |
| `ghcr.io/tiaod/rssfed/migrate` | 数据库结构对齐（一次性任务） |

每次构建打两个 tag：

| tag | 说明 |
| --- | --- |
| `latest` | 仅作「最新」指针，兼容手工 `pull` |
| `sha-<完整 40 位 hash>` | **不可变版本号，部署与回滚都认它** |

> ⚠️ 是**完整 40 位** sha，不是短 hash。早期本文与 workflow 注释都写成 `sha-<短hash>`，但按短 hash 拼 tag 会 404（ghcr 上并不存在 `sha-5c4f5ce` 这种 tag）。

### 部署链路

```
push master
   │
   ├─► ci.yml                    typecheck + test（所有分支）
   │
   └─► build-images.yml
         ├─ job test             needs 门禁：测试不过就不构建
         ├─ job build            构建 server/web/migrate 并推送 ghcr（latest + sha-<hash>）
         └─ job record-release   把 IMAGE_TAG=sha-<hash> 写进 deploy/release.env 并提交
                                       │
                                       ▼
                              Doco CD（服务器上常驻，轮询 master）
                                 检测到新提交 → clone → docker compose up
                                 按 compose 的 depends_on 先跑完 migrate
                                       │
                                       ▼
                                 server / web 起来 → 宿主机 Caddy 反代
```

### 为什么是「服务器主动拉」而不是「CI 推过去」

CI 反连服务器部署，要求把生产私钥交给云端 Runner；而构建阶段会执行第三方依赖的代码，供应链一旦出问题，等于把服务器钥匙一并交出去。实测本机 `ghcr.io` 可达、到 `github.com` 的 **SSH(22) 通**（而 HTTPS 443 超时），所以走「服务器自己 clone + 自己拉镜像」，CI 全程不持有任何服务器凭证。

### 组件

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| [`.doco-cd.yml`](../.doco-cd.yml) | 仓库根 | 告诉 Doco CD 怎么部署这个 stack |
| [`deploy/doco-cd.yml`](../deploy/doco-cd.yml) | 服务器 `~/rssfed/` | 拉起 doco-cd 容器本身 |
| [`deploy/release.env`](../deploy/release.env) | 仓库（**由 CI 写**） | 携带 `IMAGE_TAG=sha-<hash>`，即发布指针 |

Doco CD 容器：`ghcr.io/kimdre/doco-cd:0.122.0`（**必须 ≥ 0.121.0**，见下方第 3 条契约），纯轮询、不发布任何端口、`cap_drop: ALL`、`mem_limit: 256m`。

启动与查看：

```bash
cd ~/rssfed
docker compose -f doco-cd.yml up -d
docker compose -f doco-cd.yml logs -f
```

### 三条不能碰的契约

这三条都是实际踩过或从源码确认的，改动 compose 或 CI 时务必留意。

**① compose 里不能有 `build:` 段**

Doco CD 每次部署都会**无条件**调用 compose 的构建阶段（源码 `internal/docker/compose_deploy.go` 里 `service.Build` 直接跟在 pull 之后，没有条件分支）。而生产机只有 2G 内存，构建 Nuxt 必然 OOM —— 这正是「镜像改由 CI 构建」的初衷。所以 [`docker-compose.prod.yml`](../docker-compose.prod.yml) 里刻意删掉了 migrate/server/web 的 `build:` 段。本地要构建镜像时直接打 `docker build --target server .`，不要走这个文件。

**② `env_file` 与 bind mount 的路径语义不同，都要可用变量覆盖**

Doco CD 是把仓库 clone 到**自己的目录**再执行 compose，所以：

- `env_file: .env.production` 会指向 clone 目录，而该文件含密钥、**不在仓库里**。更糟的是它写了 `required: false`，缺失不会报错，只会安静地少传变量——`BETTER_AUTH_SECRET` / `ADMIN_*` / `STORAGE_S3_*` 全部丢失，表现为认证异常、对象存储失灵而不是启动失败。这条路径由 `RSSFED_ENV_FILE` 覆盖，指向**容器内**挂载点（该指令是 doco-cd 进程自己读文件）。
- `./deploy/couchdb-proxy-auth.ini` 这种 bind mount 源会随 revision 的 clone 目录漂移，导致 couchdb 每次部署都被重建。这条由 `RSSFED_DEPLOY_DIR` 覆盖，指向**宿主机**固定路径（bind mount 源由 Docker daemon 解析）。

两个变量看着重复，实际指向不同的命名空间，不能合并。

**③ 触发信号必须晚于镜像就绪**

Doco CD 的触发信号是 **git 变更**，而镜像要等 CI 构建完（实测约 4 分钟）才存在。如果让它直接跟随 `master`：

```
t0        push
t0+几秒    Doco CD 轮询到新提交 → up → 但 ghcr 上还是上一版镜像 → 部署"成功"
t0+4min   CI 构建完成
          ← 提交没有再变，Doco CD 不再触发 → 线上永久停在旧版本
```

失败的是「部署成功但内容旧」，日志完全正常。所以 `build-images.yml` 里加了 `record-release` job：构建**成功后**才把 sha 写进 `deploy/release.env` 并提交（带 `[skip ci]` 防循环）。这样触发信号天然落在镜像就绪之后，顺带拿到不可变版本号与精确回滚能力。**这个顺序不能倒过来。**

### 首次接管现有 stack

现有 stack 是用 `docker compose` CLI 手工创建的，交给 Doco CD 时：

- **project 名必须保持 `rssfed-prod`**（`.doco-cd.yml` 的 `name` 与 compose 的 `name` 一致）。Docker 不支持修改容器 labels，改名只能新建 project 并手工迁移数据；名字一致才能复用既有具名卷（`rssfed-prod_postgres-data` 等），**数据不丢**。
- 现有容器没有 `cd.doco.*` 标签，Doco CD 会视为「未部署」，首次部署会写入标签，因此**容器会被重建一次**。具名卷不受影响。
- `remove_orphans` 默认开启。compose 里的 `seaweedfs` 属于 `profiles: ["s3"]`，而 `.doco-cd.yml` 没启用该 profile，因此它会被当作不存在（当前实例用 `STORAGE_DRIVER=fs`，本就没跑它）。要启用 S3 后端时，记得同步在 `.doco-cd.yml` 里加 `profiles: ["s3"]`。

### 手工兜底与回滚

不经过 Doco CD 也能操作（例如 doco-cd 本身出问题）：

```bash
cd ~/rssfed
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build
```

回滚 = 让部署源指回旧版本：

```bash
# 把 deploy/release.env 的 IMAGE_TAG 改成目标历史 sha，提交后 Doco CD 会自动部署回去
# 历史版本号用 ghcr 的 tag 列表查，或用「最近构建成功」的 run 记录
```

> 注意两点：`prune_images: true` 会在部署后清理不再使用的旧镜像，回滚时需要重新从 ghcr 拉（tag 都还在，可行）；而**数据库迁移的固有限制不变** —— `migrate` 已执行过的结构变更不会自动撤销，含破坏性 schema 改动的发布需人工评估。

### 日常发布

发布就是 `git push origin master`，之后无需任何操作：

1. CI 跑测试 → 构建三个镜像推 ghcr；
2. `record-release` 把 `IMAGE_TAG=sha-<hash>` 写进 `deploy/release.env` 并提交（带 `[skip ci]`）；
3. Doco CD 最多 3 分钟后轮询到该提交 → 拉镜像 → 先跑 `migrate` → 重建 `server`/`web`。
   `postgres`/`couchdb`/`redis` 不受影响，全程不会被重建。

> ⚠️ **push 可能被 CI 的自动提交顶掉**：`record-release` 会往 master 提交一次。若你紧接着 push，会得到 `! [rejected] ... (fetch first)`。解决：
>
> ```bash
> git pull --rebase && git push
> ```
>
> 想省事可一次性配置 `git config pull.rebase true`。

### 排障

```bash
docker compose -f doco-cd.yml logs --tail=200 doco-cd      # 部署日志（阶段推进会反复打印）
docker compose -f docker-compose.prod.yml ps               # 应用容器状态
docker compose -f docker-compose.prod.yml logs --tail=200 server
docker inspect doco-cd --format '{{.RestartCount}} {{.State.OOMKilled}}'
```

**首次接入时实际踩到的四个坑**（按出现顺序记录，避免重复排查）：

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `SSH_PRIVATE_KEY_FILE … permission denied` | `cap_drop: ALL` 一并移除了 `CAP_DAC_OVERRIDE`，容器内 root 读不了属主为 ubuntu 的 600 文件 | 私钥 `chown root:root` + `chmod 600` |
| `knownhosts: key mismatch`（但指纹核对是对的） | keyscan 只扫了 `ed25519,rsa`，漏了 `ecdsa`，而 Go 的 SSH 客户端会协商到 ecdsa | 用**不加 `-t`** 的 `ssh-keyscan github.com` 扫全类型 |
| compose 插值报 `required variable PUBLIC_URL is missing` | `env_file` 只给容器设变量，**完全不参与 compose 的 `${}` 插值** | 把 `.env.production` 加进 `.doco-cd.yml` 的 `env_files` |
| `/config/.env.production: permission denied` | 同第一条的 cap_drop 问题 | `.env.production` 设 `chown ubuntu:root` + `chmod 640` |

**其它常见现象**：

- 反复报「镜像不存在」→ `deploy/release.env` 的指针指向了尚未构建的 sha，或 `record-release` job 未成功。
- `pulling images` 阶段超时 → 默认 `timeout` 是 180s，本项目设为 300s；带宽慢时首次拉大镜像仍可能不够，按需调大。
- 容器被反复重建 → `reconciliation` 默认监听 `unhealthy` 事件并重启容器；先看应用自身日志确认是否真的不健康。

### 包可见性

> **当前状态（2026-09-21）**：`rssfed/server`、`rssfed/web`、`rssfed/migrate` 三个包已设为 **public**，服务器直接 `pull` 即可，无需登录，doco-cd 也不需要任何 registry 凭证。若将来改回 private，再补一次登录：

```bash
echo "<PAT>" | docker login ghcr.io -u tiaod --password-stdin
# PAT 只需 read:packages 权限
```

> ⚠️ **改包可见性时最容易漏的两点**（2026-09-21 实际踩过）：
> 1. **仓库转 public 不会连带改包** —— ghcr 包的可见性是独立设置，三个包要各自进 Package settings → 底部 Danger Zone → Change visibility → Public，而且**必须手动输入包名确认**，点完按钮不等于改完。
> 2. 漏掉任何一个都会让 `pull` 以 `unauthorized` 失败。尤其别漏 `migrate`：它挂在 `server` 的 `depends_on: service_completed_successfully` 上，拉不到会让整个 `up` 起不来（`server`/`web` 即使已经拉到也不会启动）。
