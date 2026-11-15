# RSSFed

离线优先的资讯聚合与推送工具：用 RSS 抓取你真正关心的内容，在浏览器里离线阅读，并以 ActivityPub Bot 的身份把内容分发到 Fediverse。

## 能力

- **RSS 聚合** —— 自实现抓取引擎（BullMQ 定时调度 + feedsmith 解析），支持 OPML 导入、正文 HTML 与图片缓存
- **离线优先阅读** —— 服务端 CouchDB（每个订阅源独立库）与浏览器 PouchDB 同步，断网可读，联网后自动合并已读/收藏状态
- **ActivityPub 分发** —— 通过 BotKit（基于 Fedify）把聚合内容以 Bot 身份推送到 Fediverse
- **MCP 端点** —— 提供 `/mcp` 供 AI 助手管理订阅

## 技术栈

pnpm workspace monorepo，两个包：

| 包 | 技术 |
| --- | --- |
| `packages/hono-server` | Hono · Better Auth · PostgreSQL (Drizzle ORM) · CouchDB · BullMQ (Redis) · BotKit (Fedify) |
| `packages/nuxt-client` | Nuxt 4 (SSR) · Nuxt UI · Pinia · PouchDB |

架构细节、模块划分与数据流见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 本地开发

前置：Node ≥ 20、pnpm、Docker。

```bash
pnpm install

# 起依赖服务：PostgreSQL / CouchDB / Redis / SeaweedFS（dev profile）
docker compose -f packages/hono-server/docker-compose.yml --profile dev up -d

# 准备环境变量（按需修改端口与凭据）
cp packages/hono-server/.env.example packages/hono-server/.env

# 建表
pnpm db:push

# 同时起前后端：前端 :3000，后端 :3001
pnpm dev:all
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:all` | 并行运行前后端 |
| `pnpm dev` / `pnpm dev:nuxt` | 只起后端 / 只起前端 |
| `pnpm test` / `pnpm typecheck` | 测试 / 类型检查 |
| `pnpm db:push` | 推送 Drizzle schema 变更到数据库 |

## 部署

生产部署（Docker Compose + 宿主机反向代理 + CI 构建镜像）见 [docs/docker-deployment.md](docs/docker-deployment.md)。

要点：

- 镜像由 GitHub Actions 构建并推送到 ghcr，服务器只负责拉取运行（服务器内存不足以构建 Nuxt）；
- 前端与后端**同域**部署，反代按路径分流，`/api/*` 之外还有 `/mcp`、`/.well-known/*`、`/ap/*` 等联邦端点；
- 正文图片存 CouchDB 附件，头像等上传文件走可切换的存储后端（本地文件或 S3 兼容存储）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构不变量与取舍：模块划分、库职责、部署拓扑、数据流 |
| [docs/frontend-list-rendering.md](docs/frontend-list-rendering.md) | 前端四种列表视图、虚拟化、已读/收藏交互 |
| [docs/offline-and-pwa.md](docs/offline-and-pwa.md) | Service Worker 离线策略、PWA manifest 与图标 |
| [docs/docker-deployment.md](docs/docker-deployment.md) | 生产部署：镜像、编排、反代、存储、CI |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 踩坑记录：现象 → 原因 → 解法 |
| [docs/cloud-deployment-todo.md](docs/cloud-deployment-todo.md) | 尚未落地的事项与部署运维知识 |
| [docs/archive/](docs/archive/) | 已归档方案稿（MCP 助手、dsh 桥接） |

## 许可证

[AGPL-3.0](LICENSE)

整个项目按 AGPL-3.0 授权。这不是随手选的最严格许可证，而是依赖决定的：

`packages/hono-server` 直接依赖 `@fedify/botkit`（AGPL-3.0-only），且 `src/bots/` 由
`app.ts`、`index.ts` 无条件 import——联邦分发是运行时必经路径，不是可选插件。把本项目声明成
MIT 会承诺一批我们无权授予的自由，所以整体跟随 AGPL。Fedify 本体是 MIT，只有 BotKit 这一层是 AGPL。

**自建部署者请注意**：AGPL 第 13 条要求，如果你修改代码后对公众提供服务，必须向使用该服务的
用户提供修改后的完整对应源码（通常是在界面上放一个指向源码仓库的链接）。原样运行则只需保留本声明。
