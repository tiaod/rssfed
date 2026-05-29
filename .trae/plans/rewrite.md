# RSSFed 项目重写计划（Rewrite Plan · v3 · 折中方案）

> 本文档用于指导 AI 编程助手或开发者重写 RSSFed 项目。
> **架构定位：Nuxt 4 全栈一体 + Hono 接管后端路由。**
> 遵循 `.trae/rules/fullstack-develop.md` 中通用的代码风格约束（pnpm、ESLint 1tbs、无拖尾逗号、TDD）。

---

## 一、为什么选这套方案（架构决策记录）

三种方案对比：

| 方案 | 描述 | 优势 | 劣势 |
|---|---|---|---|
| v1（当前） | Nuxt 全栈，`server/api/*.ts` 逐文件 | 简单、运行中 | 无 RPC 类型推导，路由靠文件名 |
| v2（分离） | workspace 多包，Nuxt 纯前端 + Hono 独立后端 | 物理解耦，边界清晰 | 跨域 cookie 调试痛苦，多进程部署 |
| **v3（折中）✅** | Nuxt 全栈，`server/api/[...all].ts` 一个 catch-all 交给 Hono | 同 v1 的部署简单性 + v2 的 Hono RPC / Zod 类型推导 | 无物理隔离（对单人项目不是问题） |

**选 v3 的核心原因**：

1. **零架构迁移成本**——不拆仓库、不配跨域、不砍进程，只在现有 `server/` 目录内做改造。
2. **拿 Hono 的好处且不付代价**——RPC 类型推导、Zod 校验、中间件链、`app.request()` 秒级测试全部到手。
3. **性能无损**——Hono 嵌在 Nitro 内是同进程调用，无网络跳、无序列化开销。详见 §二。
4. **退路干净**——如果 Hono 在某些场景不适用，随时可以切回逐文件的 `defineEventHandler`，因为 `server/api/` 下同时存在两种 handler 是合法的。

---

## 二、架构总览

```
┌──────────────────────────────────────────────────────┐
│                  Nuxt 4 全栈进程                       │
│                                                      │
│  app/                      server/                   │
│  ├─ pages/                 ├─ api/[...all].ts──────────┐
│  ├─ components/            │    └─ Hono app.fetch()   │
│  ├─ composables/           │       ├─ /api/auth/*     │
│  │  └─ useApi() ──────────│───────┤─ /api/miniflux/* │
│  │     hono/client ◀───RPC│类型───▶├─ /api/files/*    │
│  │     同源 cookie 直通    │       │─ /api/site-*     │
│  └─ ...                    │       └─ ...             │
│                            ├─ federation.ts           │
│                            │   (@fedify/nuxt 独立)    │
│                            └─ middleware/             │
│                                  └─ auth.ts           │
│                                                      │
│  app/lib/                               同进程无网络  │
│  ├─ auth.ts (Better Auth) ◀──────────── 直接 import  │
│  ├─ db.ts  (Drizzle + PG)                             │
│  └─ schema/ (Drizzle 表定义)                          │
│                                                      │
│  ┌──────┐  ┌──────┐  ┌──────────┐                    │
│  │ PG 17│  │Redis8│  │ Miniflux │                    │
│  └──────┘  └──────┘  └──────────┘                    │
│                             ▲                         │
│                   ActivityPub (Fedify)                │
└──────────────────────────────────────────────────────┘
```

**关键特性**：

- **同源 cookie**：Nuxt 服务端和浏览器共享同一个 origin，Better Auth session cookie 天然工作，无需 CORS/SameSite/mkcert。
- **一个 Hono 实例统一所有 API**：`server/api/[...all].ts` 构造一个 Hono app，所有业务路由挂上面。
- **Fedify 不动**：继续用 `@fedify/nuxt` 模块，它注册自己的路由（`/.well-known/*`、`/users/*`、`/inbox`），不和 Hono 冲突。
- **前端 RPC**：`app/composables/useApi.ts` 用 `hc<AppType>` 获得端到端类型推导。

---

## 三、技术栈

| 层 | 选型 |
|---|---|
| 框架 | **Nuxt 4**（全栈，`app/` + `server/`） |
| UI | **@nuxt/ui v4** + Tailwind CSS v4，禁用自带字体 |
| 状态管理 | **Pinia**（`@pinia/nuxt`） |
| 后端路由 | **Hono**（嵌在 `server/api/[...all].ts`，由 Nitro 驱动） |
| 联邦协议 | **@fedify/nuxt** + `@fedify/redis`（保持不变） |
| ORM | **Drizzle ORM** + `drizzle-kit` |
| 数据库 | **PostgreSQL 17** |
| 缓存 | **Redis 8**（`ioredis`） |
| 鉴权 | **Better Auth** + `@better-auth/drizzle-adapter` + `@better-auth/redis-storage` |
| 校验 | **Zod** + `@hono/zod-validator` |
| 对象存储 | S3 兼容（Garage），`@aws-sdk/client-s3` |
| RSS 后端 | 外置 **Miniflux**（容器化） |
| 包管理 | **pnpm 10** |
| Lint | `@nuxt/eslint`，**1tbs**，**无拖尾逗号** |
| 测试 | **Vitest 4**，TDD |

---

## 四、仓库结构（单仓，不拆）

```
rssfed/
├─ nuxt.config.ts
├─ package.json
├─ tsconfig.json
├─ eslint.config.mjs
├─ vitest.config.ts
├─ vitest.setup.ts
├─ drizzle.config.ts
├─ docker-compose.yml
├─ .env / .env.example
│
├─ app/
│  ├─ app.vue
│  ├─ app.config.ts
│  ├─ assets/css/main.css
│  ├─ layouts/                 # default / none
│  ├─ pages/
│  │  ├─ index.vue
│  │  ├─ entries.vue
│  │  ├─ timeline.vue
│  │  ├─ notifications.vue
│  │  ├─ profile.vue
│  │  ├─ auth/
│  │  │  ├─ login.vue
│  │  │  └─ signup.vue
│  │  ├─ admin/
│  │  │  └─ users.vue
│  │  ├─ settings/
│  │  └─ rss/[type]/[id]/
│  ├─ components/
│  │  ├─ AppLogo.vue
│  │  ├─ UserMenu.vue
│  │  ├─ FeedNavigation.vue
│  │  ├─ EntryList.vue
│  │  ├─ EntryDetail.vue
│  │  ├─ NotificationsSlideover.vue
│  │  └─ upload/FileUpload.vue
│  ├─ composables/
│  │  ├─ useApi.ts              # hono/client RPC 入口
│  │  └─ useFeedNavigation.ts
│  ├─ stores/
│  │  └─ user.ts
│  ├─ lib/
│  │  ├─ auth.ts                # Better Auth 服务端实例
│  │  ├─ auth-client.ts         # Better Auth 客户端
│  │  ├─ db.ts                  # Drizzle 客户端
│  │  ├─ redis.ts               # ioredis 单例
│  │  ├─ schema/                # Drizzle 表定义
│  │  │  ├─ auth.ts
│  │  │  ├─ miniflux.ts
│  │  │  ├─ federation.ts
│  │  │  ├─ files.ts
│  │  │  └─ site-settings.ts
│  │  └─ miniflux/              # Miniflux 客户端 + 账号服务
│  │     ├─ client.ts
│  │     ├─ service.ts
│  │     └─ types.ts
│  ├─ plugins/                  # Nuxt 客户端插件
│  └─ types/
│
├─ server/
│  ├─ api/
│  │  └─ [...all].ts            # Hono 主入口 — 唯一 API 路由文件
│  ├─ middleware/
│  │  └─ auth.ts                # 注入 session 到 event.context
│  ├─ routes/                   # Hono 子路由（被 [...all].ts 挂载）
│  │  ├─ auth.ts
│  │  ├─ miniflux.ts
│  │  ├─ files.ts
│  │  ├─ site-settings.ts
│  │  └─ federation.ts          # 仅业务 API（timeline/notifications），Fedify 本身走 @fedify/nuxt
│  ├─ services/
│  │  ├─ miniflux/              # 代理 + 账号托管
│  │  └─ storage/               # S3 适配器
│  ├─ utils/
│  └─ federation.ts             # Fedify 实例（@fedify/nuxt）
│
└─ drizzle/                      # 迁移产物
```

> `server/api/` 下**只保留 `[...all].ts`**。Miniflux 的 `[...all].ts` 不再需要——代理逻辑迁到 Hono 子路由。
> 路由文件放 `server/routes/` 而非 `server/api/`，避免 Nitro 把它们当成独立 API 端点。

---

## 五、核心改造点与代码片段

### 5.1 Hono 入口：`server/api/[...all].ts`

```ts
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import authRoute from '../routes/auth'
import minifluxRoute from '../routes/miniflux'
import filesRoute from '../routes/files'
import siteSettingsRoute from '../routes/site-settings'
import federationRoute from '../routes/federation'

const app = new Hono()
  .use(logger())
  // 统一错误处理
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: { code: err.status, message: err.message } }, err.status)
    }
    console.error('[api-error]', err)
    return c.json({ error: { code: 500, message: 'Internal Server Error' } }, 500)
  })
  .route('/api/auth', authRoute)
  .route('/api/miniflux', minifluxRoute)
  .route('/api/files', filesRoute)
  .route('/api/site-settings', siteSettingsRoute)
  .route('/api/federation', federationRoute)

export type HonoApp = typeof app

// Nitro 的 defineEventHandler 接收标准 Request → Response
export default defineEventHandler((event) => {
  // 把 Nitro event.context 注入到 Hono context（session 等）
  event.context.hono = { nitroEvent: event }
  return app.fetch(event.node.req, event.node.res)
})
```

### 5.2 鉴权保持原位

`app/lib/auth.ts` —— **和当前代码库完全一样的位置、一样的写法**，不需要改：

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { redisStorage } from '@better-auth/redis-storage'
import { db } from './db'
import { redis } from './redis'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secondaryStorage: redisStorage({ client: redis, keyPrefix: 'better-auth:' }),
  // 同源，无需 trustedOrigins / SameSite 配置
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: true
  },
  session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  plugins: [admin(), organization({ /* ... */ }), customSession(/* ... */)]
})
```

**最大的优势**：因为同源，不需要 `trustedOrigins`、不需要 `defaultCookieAttributes` 跨站配置、不需要 `mkcert`。Better Auth 开箱即用。

### 5.3 Hono 路由中挂载 Better Auth

`server/routes/auth.ts`：

```ts
import { Hono } from 'hono'
import { auth } from '../../app/lib/auth'

export default new Hono()
  .on(['GET', 'POST'], '/*', (c) => auth.handler(c.req.raw))
```

> 注意：Hono 跑在 Nitro 内部，拿到的 `c.req.raw` 就是原始 Web `Request`，Better Auth handler 可以正常工作。

### 5.4 Hono RPC 类型导出与前端使用

类型需要在 `nuxt.config.ts` / `tsconfig.json` 中能被 `app/` 引用到。做法：

**方式 A（推荐，无循环依赖）**：`hc` 的泛型用 `typeof app` 手动写类型文件。

```ts
// server/routes/_types.ts  ——  只导类型，不导代码
import type app from '../api/[...all]'
export type HonoApp = typeof app
```

```ts
// app/composables/useApi.ts
import { hc } from 'hono/client'
import type { HonoApp } from '../../server/routes/_types'

// Nitro 同源，不需要 baseURL，直接用空字符串
export const api = hc<HonoApp>('')

// 类型安全的调用示例：
// const res = await api.miniflux.account.$get()
// res.minifluxUserId  ← 有 TS 提示
```

**方式 B**：通过 Nitro `virtual:#internal/nitro` 或其他 Nuxt 自动导入机制拿到类型，但不如 A 直接。

### 5.5 Fedify 保持不变

`server/federation.ts` 无需改动。`@fedify/nuxt` 模块独立注册自己的路由，不和 Hono 的 `[...all].ts` 冲突，因为 URL 前缀不同（`.well-known`、`/users/`、`/inbox` vs `/api/`）。

唯一新增的是 `server/routes/federation.ts` —— 为前端提供联邦数据的**业务 API**（timeline 列表、通知列表、关注 / 取关），它**只读 federation 表**，不走 ActivityPub 协议：

```ts
import { Hono } from 'hono'
import { db } from '../../app/lib/db'
import { federationTimelineEntry, federationFollower, federationFollow } from '../../app/lib/schema/federation'

export default new Hono()
  .get('/timeline', async (c) => {
    const entries = await db.query.federationTimelineEntry.findMany({
      orderBy: (e, { desc }) => desc(e.published),
      limit: 50
    })
    return c.json(entries)
  })
  .get('/notifications', async (c) => {
    const followers = await db.query.federationFollower.findMany({
      orderBy: (f, { desc }) => desc(f.createdAt),
      limit: 30
    })
    return c.json(followers)
  })
  // ... follow / unfollow
```

---

## 六、功能模块（同 v2，调整归属路径）

### 6.1 鉴权与用户体系

- **position**：`app/lib/auth.ts`（同现在，不动）。
- Hono 路由 `server/routes/auth.ts` 挂载 `auth.handler`。
- 同源 cookie 天然工作，**零跨域配置**。
- 业务规则不变：邮箱验证、admin、organization、customSession、注册后钩子。

### 6.2 Miniflux 集成

- `app/lib/miniflux/`：client.ts / service.ts / types.ts（不动）。
- `server/routes/miniflux.ts`：反向代理 + `account.get`，用 Hono proxy + Zod 校验请求。

### 6.3 ActivityPub 联邦

- `server/federation.ts` 用 `@fedify/nuxt`，不做改动。
- `server/routes/federation.ts` 提供业务 API（timeline / notifications / follow / unfollow），只读 DB。

### 6.4 RSS 阅读 / 文件上传 / 站点设置

- 前端路径不变。
- 后端全部迁到 `server/routes/*.ts`，每个路由用 Hono 子 router。

---

## 七、数据模型

放 `app/lib/schema/`（当前位置不动），拆分为：

- `auth.ts` / `miniflux.ts` / `federation.ts` / `files.ts` / `site-settings.ts`
- 通用约束：主键 `text('id').primaryKey()`、`crypto.randomUUID()` 生成、`updatedAt` 用 `$onUpdate(() => new Date())`、高频字段建索引。

`drizzle.config.ts` 的 schema glob：`./app/lib/schema/*.ts`（不变）。

---

## 八、环境变量

沿用原 `.env.example`，**无需新增任何跨域相关变量**。

```bash
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://localhost:3000    # 同源，就是 Nuxt 自己的地址
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
MINIFLUX_BASE_URL=http://localhost:8080
MINIFLUX_ADMIN_USERNAME=...
MINIFLUX_ADMIN_PASSWORD=...
# S3 存储
STORAGE_S3_ENDPOINT=...
STORAGE_S3_REGION=...
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_S3_BUCKET=...
STORAGE_S3_FORCE_PATH_STYLE=true
```

---

## 九、`nuxt.config.ts` 配置

```ts
export default defineNuxtConfig({
  modules: [
    '@pinia/nuxt',
    '@nuxt/eslint',
    '@nuxt/ui',
    '@fedify/nuxt',
    process.env.NODE_ENV === 'test' ? '@nuxt/test-utils/module' : null
  ].filter(Boolean),

  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  ui: { fonts: false },

  routeRules: {
    '/': { prerender: true },
    // /api/* 走 Hono catch-all，无需额外配置
  },

  nitro: {
    storage: {
      redis: {
        driver: 'redis',
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      }
    }
  },

  vite: {
    optimizeDeps: {
      include: ['better-auth/vue', 'hono/client']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  compatibilityDate: '2025-01-15'
})
```

---

## 十、开发与质量门禁

```bash
pnpm install
docker compose up -d
pnpm dev                       # 一个命令，同进程

pnpm lint                      # ESLint，0 错误
pnpm typecheck                 # vue-tsc，0 错误
pnpm test:run                  # Vitest 全量，全绿
```

- Hono 路由测试：直接在 Vitest 里 `import app from '../api/[...all]'`，用 `app.request('/api/xxx', { method, ... })` 做请求测试，无需启 server。
- Better Auth 测试：用真实 PG + Redis（CI 用 testcontainers 或 Docker service container）。

---

## 十一、分阶段实施路线图

### 阶段 1：Hono 迁入（最小破坏）

- 安装 `hono` + `@hono/zod-validator`
- 创建 `server/api/[...all].ts`，构造 Hono 实例并 export default
- 新建 `server/routes/auth.ts`，把 Better Auth handler 挂上
- 验证：`GET /api/auth/ok` 返回 `{ status: "ok" }`，登录 / 注册不受影响
- **DoD**：删除旧的 `server/api/auth/[...all].ts`，所有鉴权操作走新 Hono 路由，`pnpm lint/typecheck/test:run` 全绿

### 阶段 2：迁移现有 API 到 Hono 子路由

- Miniflux 代理 + account → `server/routes/miniflux.ts`
- 文件上传 / 下载 / 删除 → `server/routes/files.ts`
- 站点设置 → `server/routes/site-settings.ts`
- 联邦业务 API → `server/routes/federation.ts`
- 删除旧的 `server/api/miniflux/*`、`server/api/files/*`、`server/api/site-settings.*`
- **DoD**：前端所有功能正常，API 调用路由不变，`test:run` 全绿

### 阶段 3：前端接入 RPC 类型推导

- 创建 `app/composables/useApi.ts`，用 `hc<HonoApp>`
- 逐步替换 `$fetch('/api/xxx')` 为 `api.xxx.$get()`
- **DoD**：前端 API 调用全有类型提示，编译无类型错误

### 阶段 4：测试 + 部署

- 补关键链路测试（Hono 路由测试 + E2E 可选）
- 单 Dockerfile 部署（不变，Nuxt 构建产出已包含 Nitro）
- **DoD**：全量测试绿，单命令构建部署

---

## 十二、风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| `app.fetch(event.node.req, event.node.res)` 与 Nitro 的生命周期冲突 | 低 | Nitro 的 `defineEventHandler` 就是标准 Web handler 包装，Hono app 也是标准 handler，两者天然兼容 |
| `@fedify/nuxt` 注册的路由被 Hono catch-all 吞掉 | 极低 | Nitro 路由优先级：具体路径 > catch-all，`/.well-known/*` 和 `/users/*` 会被 Fedify 的路由先匹配 |
| `hono/client` 在 Nuxt SSR 环境报错（无浏览器 `fetch`） | 中 | Nuxt SSR 端有 `ofetch` 可用，在 `useApi()` 里传入自定义 fetch 函数即可 |
| 旧的 `server/api/auth/[...all].ts` 和 Hono auth 路由同时存在导致双挂载 | 中 | 阶段 1 DoD 要求删除旧文件，CI 里加一条检查 `server/api/` 下只能有 `[...all].ts` 和 `__tests__/` |

---

## 十三、代码风格

1. TypeScript 严格模式；Vue `<script setup lang="ts">`，Hono 路由用函数式
2. ESLint `1tbs`，无拖尾逗号
3. 注释用中文，关键逻辑 > 20 行考虑抽象
4. UI 优先 Nuxt UI
5. 业务错误用 `HTTPException`，`app.onError` 统一格式化
6. 联邦 IO 必须空值兜底
7. 永不提交密钥