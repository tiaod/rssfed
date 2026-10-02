# RSSFed 云端部署待办

> 交付层（镜像、编排、反代、部署流水线）已上线并通过验收；**仍未落地的只有数据备份**（仓库零实现），另有单副本约束、日志结构化、nodeinfo 三项代码层欠账，以及两项需要人工在浏览器 / fediverse 里完成的验证。
> 图例：⚠️ 部分完成｜❌ 未做
> 具体部署操作步骤不在此重复，见 [docker-deployment.md](docker-deployment.md)；本文只记「还没做的」与「换机器 / 重装时仍然成立的知识」。

## 一、未落地事项

### 1. 数据备份 ❌

编排已为 postgres / couchdb / redis / caddy 配好命名卷，但**备份机制完全没有**：全仓库 grep `pg_dump` / `pg_restore` / `backup` / `备份` 零命中；服务器侧 `ubuntu` 与 `root` 的 crontab、`/etc/cron.d`、systemd timers 也没有相关任务。上线验收中「备份任务已配置并验证过一次恢复」一直是 ❌。

备份范围与取舍（决定某个库要不要备份的关键）：

| 数据 | 位置 | 丢了能否重建 |
| --- | --- | --- |
| `user-state_*` | CouchDB | **完全不可重建**：存用户订阅关系（`subscription` 文档）与已读 / 收藏状态，PostgreSQL 侧没有副本（见 [ARCHITECTURE.md](../ARCHITECTURE.md) 的「为什么订阅关系在 CouchDB 而不在 PostgreSQL」） |
| `fedify_kv_v2` | PostgreSQL `fedify` schema | **完全不可重建**：存 Bot 的 ActivityPub 密钥对，被删即永久失去联邦身份 |
| PostgreSQL（用户 / 认证 / bots / 关联表）、`uploads-data` 卷（附件） | — | 不可重建 |
| `feed_*`（每个订阅源一个库） | CouchDB | 只能重抓到**源站当前窗口内的条目**（RSS 通常只给最近 10~50 条），滚出窗口的历史条目永久丢失；正文图片需重新下载并重跑 AVIF 压缩 |
| Redis | — | 队列数据丢了可重建，优先级最低（已带 `--appendonly yes`） |

结论：即使决定不备份 `feed_*`，`user-state_*` 与 `fedify_kv_v2` 也必须带上。

### 2. 单副本约束 ⚠️

抓取调度与 BotKit 轮询都是进程内 `setInterval`（[workers/index.ts](../packages/hono-server/src/workers/index.ts)、[bots/index.ts](../packages/hono-server/src/bots/index.ts)），worker 与 API 同进程，因此**不能起第二个副本**（编排注释与部署文档已锁定单副本）。
长期方案：拆出独立 worker 进程 + 分布式锁 / leader election。

### 3. 应用日志 ⚠️

应用仍是 `console.log`，未结构化、未接集中收集。compose 层已统一 `json-file` 轮转（单文件 10MB × 3），Caddy 访问日志走 stdout。
要接集中收集：改 compose 的 `x-logging` 锚点，或让日志走 Loki / CloudWatch。

### 4. nodeinfo 未实现 ⚠️

代码没有注册 nodeinfo dispatcher（Fedify 的 `setNodeInfoDispatcher`）：`/nodeinfo/2.0`、`/nodeinfo/2.1` 返回 404，`/.well-known/nodeinfo` 返回 200 但内容为 `{"links":[]}`。属代码层缺失，**不是部署问题**，联邦功能（webfinger / actor / inbox）不依赖它。反代已放行 `/nodeinfo/*`，补上 dispatcher 后无需再改 Caddy。

### 5. 待人工验证

- [ ] **浏览器 IndexedDB 离线读**：断网后仍能读到缓存条目。服务端同步协议侧已验过（`_changes` 长轮询、`_bulk_docs`、`_revs_diff` 均正常）。
- [ ] **fediverse 实机关注**：在自己的 Mastodon 等账号里搜索并关注 bot，确认能收到推送。技术前提已在公网全部验证通过（webfinger 200 → actor 200 且含 `publicKey` → inbox 可达），只差真实交互。

## 二、与具体环境无关的部署知识

### 出网通路：必须逐域名复测

国内云主机常见「github.com 不通」，但逐域名实测结论是分裂的：

| 域名 | 结论 |
| --- | --- |
| `api.github.com` | ✅ 200 / ~0.40s |
| `ghcr.io` | ✅ 通，可匿名取 token（`/v2/` 返回 401 属正常握手） |
| `git@github.com:22` | ✅ 网络通（未配部署密钥） |
| `raw.githubusercontent.com` | ⚠️ 时通时断（偶发 25s 超时，DNS 只返回 IPv6，链路抖动） |
| `github.com`（网页） | ❌ 超时 |

**选型依据**：正因为 `api.github.com` 与 `ghcr.io` 可达，才能让服务器主动发现新版本、自己 `compose pull`，而不必把生产私钥交给 CI（见 [docker-deployment.md](docker-deployment.md) 第 10 节）。
换机器时请**分别**复测这几个域名——只看 `github.com` 通不通会得出错误结论。

### 镜像构建位置

服务器内存只有 2G 左右，容器内构建 Nuxt 极易 OOM，因此**镜像一律由 CI 构建推送到 ghcr**，服务器只负责拉取运行。

### 反向代理

复用宿主机已有的 Caddy：只在其配置**末尾追加**一个站点段，不动既有站点；TLS 由 Caddy 自动签发。后端 matcher 的具体分流规则见 [docker-deployment.md](docker-deployment.md) 第 3 节。

### 部署形态

| 项 | 值 |
| --- | --- |
| 部署目录 | `~/rssfed/`：只需 [docker-compose.prod.yml](../docker-compose.prod.yml) + `.env.production`（权限 600），无需完整源码 |
| 镜像 | CI 构建推送到 ghcr（`latest` + 完整 40 位 `sha-<hash>`），服务器 `compose pull`；本地构建仅用于开发；镜像定义见 [Dockerfile](../Dockerfile) |
| 文件存储 | `STORAGE_DRIVER=fs`，数据在 `uploads-data` 卷（`/app/data/uploads`），附件走 `/api/files/*` 代理；SeaweedFS 保留为可选（`--profile s3`） |
| 启动 | `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build` |
| 资源 | 上线后实测约 900Mi 内存（5 个容器）；抓取 + AVIF 压缩与 API 抢 CPU / 内存，建议 2 核 4GB 起步 |

> **CI/CD 现状**：[ci.yml](../.github/workflows/ci.yml) 只跑 typecheck + test；早期记为欠账的「构建推送镜像 + 部署流水线」已由 [build-images.yml](../.github/workflows/build-images.yml) + Doco CD 落地，详见 [docker-deployment.md](docker-deployment.md) 第 10 节。

### schema 变更的两个坑

- `migrate` 服务在 server 启动前单次执行 `drizzle-kit push --force`。`--force` 会自动批准数据丢失语句（可能 truncate 表）：首次部署无风险，后续删列 / 改类型前先 `--verbose` 复核。详见 [docker-deployment.md](docker-deployment.md) 第 5 节。
- Fedify 自建自管的 `fedify_kv_v2` / `fedify_message_v2` 不在仓库 schema 里，`push` 会把它们当多余表 **DROP TABLE**（`--force` 自动批准；**空表时甚至不提示，直接静默删除**）。`fedify_kv_v2` 存着 ActivityPub 密钥对，被删即永久丢失联邦身份。现已迁到独立 schema `fedify`（启动时 `ensureFedifySchema()` 幂等创建），并保留 [drizzle.config.ts](../packages/hono-server/drizzle.config.ts) 的 `tablesFilter` 作第二道防线。
- `push` 只对齐结构、不回填数据；新增非空列之类改动需手动补数据。

## 三、相关文档

- [docker-deployment.md](docker-deployment.md)：部署步骤、镜像说明、路由规则、环境变量、数据库变更、运维备注、其他部署形态
- [ARCHITECTURE.md](../ARCHITECTURE.md)：架构与部署章节
- [troubleshooting.md](troubleshooting.md)：排障记录
