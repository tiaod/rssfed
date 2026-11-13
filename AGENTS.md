# RSSFed

离线优先的 RSS 阅读器：服务端定时抓取用户订阅，浏览器经 PouchDB 同步后可离线阅读，条目可由
ActivityPub Bot 以联邦身份分发。pnpm workspace monorepo：

| 包 | 职责 | 栈 |
| --- | --- | --- |
| `packages/hono-server` | API、抓取与聚合 Worker、联邦、MCP 端点 | Hono · Better Auth · PostgreSQL(Drizzle) · CouchDB · BullMQ(Redis) · BotKit(Fedify) |
| `packages/nuxt-client` | Web 前端与离线阅读 | Nuxt 4 (SSR) · Vue 3 `<script setup>` · Nuxt UI · Pinia · PouchDB |

架构不变量、库职责、数据流见 [ARCHITECTURE.md](ARCHITECTURE.md)，这里不重复。
开发期前端 3000、后端 3001；生产由 Caddy 同域分流，`/api/*` 之外还有 `/mcp`、`/.well-known/*`、`/ap/*`。

## 结构

- `hono-server/src/`：`routes/` 路由装配、`services/` 业务、`workers/` 抓取与聚合队列、`couchdb/` 库与复制、
  `db/` Drizzle schema、`rss/` 解析、`bots/` 活动流、`images/` 图片缓存
- `nuxt-client/app/`：`pages/` · `components/` · `composables/`（`usePouchDb` 是本地库）· `stores/` · `utils/`；
  另有 `e2e/`（Playwright）与 `integration/`（真栈 vitest）
- `deploy/` 反代与 CouchDB 配置、`docs/` 见文末

## 本地运行

前置 Node ≥ 20、pnpm、Docker。

```bash
pnpm install
docker compose -f packages/hono-server/docker-compose.yml --profile dev up -d   # pg/couchdb/redis/seaweedfs
cp packages/hono-server/.env.example packages/hono-server/.env
pnpm db:push        # 建表；见下面「坑」
pnpm dev:all        # 前后端并行。也可 pnpm dev / pnpm dev:nuxt 单独起
```

`pnpm test`、`pnpm typecheck` 不依赖任何外部服务，随时可跑（CI 只跑这两项；`pnpm lint` 只覆盖
nuxt-client，别指望它挡住问题）。`test:e2e` / `test:integration` 需要 dev 栈在跑，见 `nuxt-client/e2e/README.md`。

## 坑

- **`pnpm db:push` 会执行破坏性语句**：生产 migrate 跑 `push --force`，自动批准 DROP / truncate。
  Fedify 的 `fedify_kv_v2` 存 Bot 私钥，必须留在独立 `fedify` schema；给已有数据的表加 `.unique()`
  会触发「是否 truncate」。成因与处置见 [docs/troubleshooting.md](docs/troubleshooting.md)。
- **`hono-server/src/db/auth-schema.ts` 是生成物但已手改**（`avatarAttachmentId`、`timelineDbName` 等），
  `pnpm auth:generate` 当前不可用，别重跑生成器，直接改文件。
- **`report/` 不进版本控制、约 1GB**，含第三方源码与它们自己的 AGENTS.md，不要读、不要全仓库 grep 进去。

## 约定

- TypeScript；文件名 kebab-case，但前端 `.vue` 用 PascalCase、composable/store/util 用 camelCase。
- 注释只写「为什么」和「反直觉的坑」，不写代码在做什么；踩坑经过记 `docs/troubleshooting.md`。
- 交互与状态流转补 vitest；纯 UI 细节开浏览器看实际效果即可。
- 提交信息用中文 + Conventional Commits，scope 取 `nuxt` / `server` / `deploy` 等领域名。

## 文档（按需读，不要通读 docs/）

| 要查什么 | 读哪份 |
| --- | --- |
| 不变量、库职责、部署拓扑、数据流 | `ARCHITECTURE.md` |
| 前端列表、虚拟化、已读收藏交互 | `docs/frontend-list-rendering.md` |
| Service Worker、PWA、图标 | `docs/offline-and-pwa.md` |
| 部署步骤、镜像、反代 | `docs/docker-deployment.md` |
| 现象 → 原因 → 解法 | `docs/troubleshooting.md` |
| 调研留档（非现行规范） | `docs/notes/` |
| 尚未落地的事项 | `docs/cloud-deployment-todo.md` |
| 已归档方案稿 | `docs/archive/` |

功能提交不默认附带文档改动：只有不变量变了（新增存储层、改变同步方向、换传输协议）才更新 `ARCHITECTURE.md`。
