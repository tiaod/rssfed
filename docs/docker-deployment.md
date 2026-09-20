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

# 2) 构建并启动（--profile tls 会额外拉起 Caddy 自动申请 HTTPS 证书）
docker compose --env-file .env.production -f docker-compose.prod.yml --profile tls up -d --build
```

启动顺序由编排保证：`postgres`/`couchdb`/`redis` 健康 → `migrate` 对齐表结构 → `server` → `web` → `caddy`。

验证：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl -s https://<你的域名>/api/health          # {"status":"ok"}
curl -s https://<你的域名>/nodeinfo/2.1        # 联邦端点
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
| `/mcp`、`/mcp/*` | server，**不做 301/307**（重定向会让 MCP 客户端丢掉 `Authorization` 头） |
| `/.well-known/*` | server（webfinger） |
| `/nodeinfo/*` | server |
| `/users/*`、`/inbox` | server（Fedify actor / inbox） |
| `/admin/queues` | 反代直接 404（队列看板不对外） |
| 其余 `/` | web（Nuxt SSR） |

**只转 `/api/*` 是最常见的踩坑**：ActivityPub 端点挂在 Hono 的 `app.all("*")` 兜底上，漏了 `/mcp`、`/.well-known/*`、`/users/*` 会让联邦与 MCP 整体 404。

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
curl -s https://<域名>/api/health
curl -s https://<域名>/nodeinfo/2.1
curl -s "https://<域名>/.well-known/webfinger?resource=acct:<bot名>@<域名>"
curl -s https://<域名>/mcp/ -o /dev/null -w '%{http_code}\n'   # 不能是 3xx
```

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

- **单副本**：抓取调度与 BotKit 轮询是进程内 `setInterval`，worker 与 API 同进程。`server` 不要 `--scale` 超过 1，否则会重复入队、重复发布 ActivityPub 活动。
- **持久化**：`postgres-data`、`couchdb-data`、`redis-data`、`seaweedfs-data`、`caddy-data` 五个命名卷必须纳入备份。CouchDB 每个订阅源一个库，是数据主体，别只备份 PostgreSQL；`seaweedfs-data` 存的是正文图片与头像附件。
- **日志**：compose 里统一配了 `json-file` 轮转（单文件 10MB × 3）。要集中收集就改 `x-logging` 锚点，或把 `docker logs` 接到 Loki/CloudWatch。
- **更新发布**：`git pull` 后重复 `up -d --build` 即可，`migrate` 会先跑完再滚动应用容器。
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
