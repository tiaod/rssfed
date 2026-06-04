# RSSFed 架构设计

## 项目定位

RSSFed 是一个支持 ActivityPub 的 RSS 阅读器。核心能力：

1. **RSS 定时抓取** — 自实现抓取引擎（BullMQ 调度），不依赖 Miniflux
2. **订阅管理 + 离线阅读** — 服务端 CouchDB + 客户端 PouchDB 双向同步
3. **ActivityPub 机器人** — 将 RSS 内容自动转发到 Fediverse

## 技术栈概览

| 层级 | 技术 |
|------|------|
| 包管理 | pnpm workspace (monorepo) |
| API 框架 | Hono |
| 身份认证 | Better Auth |
| 关系数据库 | PostgreSQL（Drizzle ORM） |
| 文档数据库 | CouchDB 3.x |
| 客户端离线 | PouchDB（浏览器 IndexedDB） |
| 任务队列 | BullMQ（Redis） |
| RSS 解析 | rss-parser |
| ActivityPub | Fedify |
| 前端 | Nuxt（SSR）+ Nuxt UI |

## 模块划分

```
rssfed/
├── packages/server/     # Hono API 服务（认证、RSS 抓取、ActivityPub Bot）
│   ├── src/
│   │   ├── app.ts          ← Hono app 定义（可测试导入）
│   │   ├── auth.ts         ← Better Auth 服务端配置
│   │   ├── config.ts       ← 环境变量解析（CORS origins 等）
│   │   ├── db/             ← Drizzle schema + 迁移
│   │   ├── bots/           ← ActivityPub Bot（Fedify）
│   │   ├── couchdb/        ← CouchDB 客户端（nano）
│   │   ├── routes/         ← feeds、sync、bots、subscriptions
│   │   ├── rss/            ← rss-parser 封装
│   │   └── workers/        ← BullMQ Worker（RSS 定时抓取）
│   │
│   └── src/index.ts        ← 入口，serve() 启动
│
└── packages/app/        # Nuxt 前端（SSR）
    ├── app/
    │   ├── app.vue         ← 根组件（含顶部导航 + 登录态）
    │   ├── pages/          ← 路由页面
    │   ├── stores/         ← Pinia 全局状态
    │   ├── composables/    ← auto-imported composables（含 useAuth）
    │   └── middleware/     ← Nuxt 路由中间件
    └── server/middleware/  ← Nitro 中间件（/api/* 反向代理到 Hono）
```

## 同步架构分层

```
Global CouchDB（RSS 权威来源）
    │  CouchDB _replicate（服务端触发，数据不经过 Node）
    ▼
Per-User CouchDB（用户私有）
    │  PouchDB 双向同步（浏览器 ↔ CouchDB）
    ▼
浏览器 IndexedDB（离线缓存）
```

关键设计：服务端用 CouchDB 原生 `_replicate` API 做 Global → User 的过滤复制，客户端 PouchDB 做 User → 浏览器的实时同步。是两个独立层级。

## 数据库职责划分

| 存储 | 内容 | 用途 |
|------|------|------|
| PostgreSQL（Drizzle）| 用户、bots、订阅关系、同步进度 | 核心业务、认证、关系管理 |
| CouchDB Global | feeds、entries（全局唯一） | RSS 内容权威来源 |
| CouchDB Per-User | 用户订阅条目的缓存 + read/saved 状态 | 离线阅读、PouchDB 同步 |

## 部署架构

```
反向代理（nginx / Caddy）
  ├── /api/*  → Hono（后端服务）
  └── /*      → Nuxt（SSR 渲染）
```

开发模式下 Nuxt 通过 Nitro middleware 将 `/api/*` 代理到 Hono。生产环境通过反向代理统一域名，确保 cookie 同域。

## 数据流

1. **RSS 抓取**：用户发现 feed → rss-parser 解析 → 写入 CouchDB Global → BullMQ 定时调度更新
2. **用户同步**：查订阅列表 → 触发 sync API → CouchDB _replicate Global → User DB → PouchDB 同步到浏览器
3. **离线阅读**：浏览器 PouchDB 本地缓存 → 离线可读/标记已读收藏 → 联网后自动推回
4. **ActivityPub**：Bot 定期检查新条目 → 构建 Create Activity → 发送到 follower inbox
