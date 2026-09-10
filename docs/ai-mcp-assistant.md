# RSSFed AI 助手 — MCP 服务器技术设计

> 目标：把 RSSFed 的订阅管理能力做成**标准 MCP（Model Context Protocol）服务器**，
> 使任何支持 MCP 的客户端（dsh、Claude Desktop、Cline、Cursor、Cherry Studio 等）都能
> 作为 AI 助手帮用户管理自己的订阅源 —— 推荐新源、增删订阅、整理 Bot 分组、读取内容。
>
> **设计原则：不绑定任何单一 AI 客户端。** 我们只交付标准 MCP 工具；用户用哪个工具、哪个模型，完全自由。

---

## 1. 定位与边界

| 项 | 决策 |
|---|---|
| 交付形态 | 一个 MCP server，作为 RSSFed Hono 后端的一个端点（`/mcp`）对外暴露 |
| 传输方式 | **Streamable HTTP**（当前 MCP 标准，单端点 `POST/GET /mcp`，内部使用 SSE 流式）。旧 HTTP+SSE（2024-11-05）已被弃用，不作为主目标 |
| 采用 SDK | **官方 `@modelcontextprotocol/server`** + Hono 适配 `@modelcontextprotocol/hono`（`createMcpHonoApp()` + `WebStandardStreamableHTTPServerTransport`） |
| 认证 | **用户个人 API token（Bearer）**，每个用户独立生成/吊销 |
| 职责 | 只做「用户已授权数据」的读 + 订阅相关写操作；绝不提供跨用户或 admin 级操作 |
| 工具范围 | 订阅管理、推荐新源、Bot/分组管理、读取内容（4 类，见 §3） |

### 明确不做的事
- **不为前端做一套 REST 业务接口**。RSSFed 是**离线优先**：前端通过 PouchDB `_replicate` 双向同步直接读写 CouchDB（`useCouchDb.ts` 直连 `user-state` 库），订阅增删本质上是对 CouchDB 文档的写操作，不经过"服务端 REST 业务 API"。**前端保持不变，不改造。**
  - ⚠️ 注意：这里的不做 REST，指的是**不为此项目的 web 前端**另造一套接口。**将来若确有第三方（非 AI）工具**需要接入，可基于现有 `services/` 层低成本开放 `/api/v1` REST，见 §12。
- **不在 server 内做 web 搜索 / 内容推荐**：找到候选源 URL 是调用方（AI agent）的事；MCP server 只负责「给定一个 URL，解析并校验它是不是有效订阅源、能否加入我的订阅」。
- **不做全站 feed 管理 / 其他用户数据操作**：所有工具严格限定在当前 token 对应用户。
- **不做订阅抓取本身**：抓取由 RSSFed 现有 BullMQ Worker 完成，MCP 工具只触发入队。

---

## 2. 整体架构（贴合离线优先）

关键认知：**前端数据流 与 MCP 数据流 是两条不同的路径，刻意分开。**

```
① web 前端（离线优先，改造为零）
   PouchDB 本地库 ──_replicate 双向同步──▶ CouchDB (feed:*, user-state:*)
   （订阅增删 = 直接操作 PouchDB → 同步到 CouchDB，不经服务端业务 API）

② MCP 客户端（新增）
   MCP 客户端(dsh/Claude/Cursor…) ──MCP 协议──▶ /mcp 端点（授权校验）
                                                    │ 直接调用现有服务模块
                                                    ▼
                                            RSSFed 服务端核心
                                            · rss/parser.ts  parseFeedUrl
                                            · workers        enqueueFetch
                                            · couchdb/client ensureUserStateDatabase / createCouchDb
                                            · db             feeds/bots/bot_feeds (Drizzle)
```

**为什么前端不共用 MCP 逻辑：**
- 前端是**同源 + 登录 session + 离线同步**，天然受信任，所以能直连 CouchDB。
- MCP 客户端是**外部进程 + Bearer token**，**必须**经过服务端授权和隔离，绝不能让它 `_replicate` CouchDB 库或任意读写。

**为什么两者数据形态仍一致：**
- MCP 工具写订阅时，**写入同样的 CouchDB `subscription:{feedId}` 文档**（`user-state` 库），与前端 `useCouchDb.addSubscription` 写入的文档结构一致。这样前端 PouchDB 同步下来能直接识别，不产生数据分裂。

---

## 3. 复用边界：不新写业务逻辑，直接调用现有模块

MCP 工具是**薄封装**：只负责「校验 token → 调用现有函数 → 返回结果」，**绝不重写**业务逻辑。

需要复用的现有服务模块 / 函数（均已存在）：

| 模块 | 函数 | 用途 |
|---|---|---|
| `rss/parser.ts` | `parseFeedUrl` | 解析并校验候选 URL |
| `routes/feeds.ts` | `ensureFeedRegistered`、`addSubscriptionIfAbsent`、`resolveFeedId`、`deriveFeedId` | 注册 feed + 写订阅文档（**当前是私有函数，需**移到共享模块并 export，见 §5.1） |
| `workers/index.ts` | `enqueueFetch` | 入队抓取（jobId 去重） |
| `couchdb/client.ts` | `ensureUserStateDatabase`、`createCouchDb`、`ensureFeedDatabase` | 定位用户库 / feed 库 |
| `db/schema.ts` | `feeds`、`bots`、`botFeeds` | Drizzle 表访问 |

> **注意**：`ensureFeedRegistered`、`addSubscriptionIfAbsent`、`resolveFeedId` 目前在 `feeds.ts`（路由文件）内是**未导出的私有函数**。为了让 MCP 工具（以及将来其它调用方）复用，把它们**从路由文件抽到 `services/feeds.ts` 并 export**，REST 路由改从那里 import。这是**挪动位置、不是重写**，业务逻辑保持唯一一份。

---

## 4. 工具清单

所有工具的输入/输出用 Zod schema 定义（项目已依赖 `zod`）。

### 4.1 订阅管理（核心）
| 工具 | 说明 | 复用/新增 |
|---|---|---|
| `list_subscriptions` | 列出当前用户订阅的 feed + bot（含状态） | 复用 `ensureUserStateDatabase` + allDocs `subscription:*` 范围查询 |
| `discover_feed` | 给定 URL，解析并校验是否为有效订阅源（**不订阅**） | 复用 `parseFeedUrl` + `resolveFeedId` |
| `add_subscription` | 内联 discover + 注册 feed + 为用户写订阅文档 | 复用 `ensureFeedRegistered` + `addSubscriptionIfAbsent` |
| `remove_subscription` | 删除当前用户的一条订阅文档 | **新增** `subscriptionService.remove(userId, feedId)`（删 `user-state` 库的 `subscription:{feedId}` 文档） |
| `pause_subscription` | 暂停某源抓取 | 更新 `feeds.status='paused'`（**校验归属**） |
| `resume_subscription` | 恢复抓取 | 更新 `feeds.status='active'` |
| `update_subscription` | 改订阅源元信息 | 更新 `feeds` 的 title/url/description/siteUrl/image |
| `refetch_feed` | 立即重新抓取某源 | 复用 `enqueueFetch` |

> ⚠️ **授权红线**：现有 `PATCH/PUT/refetch`、`GET /feeds` 是 `requireAdmin`（admin 级）。MCP 工具**绝不能**复用这些 admin 路由。所有工具必须：
> 1. 从 token 解析出 `userId`；
> 2. 先查 `user-state:{userId}` 确认该 feed 确在当前用户订阅里；
> 3. 只对该用户数据做操作。
> 所以要为工具提供**用户级**的服务函数（见 §5.1），而非暴露 admin 路由。

### 4.2 推荐新源
| 工具 | 说明 |
|---|---|
| `validate_candidate` | 校验一个候选 URL 是否为合法 RSS/Atom/JSON Feed（返回标题、站点链接、条目数、封面）。供 agent 订阅前核验 |
| `recommend_sources` | **可选增强**：基于用户已订阅 feed 内容/关键词推断兴趣，返回候选（见 §6） |

> 设计：推荐分两阶段 ——
> - **第一版**：agent 用自身搜索找到候选 URL → `validate_candidate` / `discover_feed` 核验 → `add_subscription` 订阅。MCP server **不内置搜索**。
> - **增强版**：`recommend_sources` 读已订阅 feed 的 title/分类/条目关键词，做相似度返回候选。需内容理解层，后置。

### 4.3 Bot / 分组管理
| 工具 | 说明 |
|---|---|
| `list_bots` | 列出当前用户的 Bot |
| `create_bot` | 创建 Bot |
| `update_bot` | 改 Bot 元信息 |
| `delete_bot` | 删除 Bot（含关联 feed + CouchDB 产出库） |
| `add_bot_feed` | 给某 Bot 关联一个 feed |
| `remove_bot_feed` | 解除关联 |
| `organize_bots` | 组合工具：让 AI 根据订阅内容把 feed 分组为若干 Bot |

> `bots` 表有 `userId` 归属，天然按用户隔离；`botFeeds` 做关联。建议限制：只允许把「用户自己订阅的源」挂进自己的 Bot。

### 4.4 读取内容/条目
| 工具 | 说明 |
|---|---|
| `get_feed` | 读单个订阅源元数据 |
| `list_entries` | 读某源最新条目（分页） | 用 `feed:{feedId}` 库 `entries-by-date` 视图 |
| `search_entries` | **可选**：在已抓取条目里按关键词搜索 |

> 读取是「AI 理解用户读什么」的基础。返回时裁剪字段（默认 title/summary/link），不返回完整正文，省 token。

---

## 5. 后端所需改动

MCP 工具**复用现有函数，不新写业务逻辑**。所需改动集中在：

### 5.1 把现有私有逻辑抽成共享服务层 `services/`
把 `feeds.ts` 路由里的私有函数移到 `packages/hono-server/src/services/feeds.ts` 并 export：
- `listSubscriptionsForUser(userId)` — 从 `user-state` 库 `subscription:*` 查询
- `ensureFeedRegistered` / `addSubscriptionIfAbsent` / `resolveFeedId` / `deriveFeedId`
- `addSubscription(userId, url)` — 内联 discover + 注册 + 写订阅文档
- `removeSubscription(userId, feedId)` — **新增**（删 `user-state` 库文档）
- `setSubscriptionStatus(userId, feedId, status)` — 校验归属 + 更新 `feeds.status`

REST 路由（`feeds.ts`）改为从 `services/feeds.ts` import 这些函数，行为不变。
> 价值：MCP 与 REST 路由共用同一份业务逻辑 + 授权校验，逻辑不分裂。

**同时新增** `routes/user-tokens.ts`（token 生成/列表/吊销）+ `routes/mcp.ts`（挂 `/mcp`）。

### 5.2 新增数据表
`api_token`（见 §6 认证）：
```
id text PK
userId text FK → user.id (onDelete cascade)
name text
tokenHash text UNIQUE     -- 只存 SHA-256 hash
prefix text               -- 明文前缀展示用
lastUsedAt timestamp
createdAt timestamp
expiresAt timestamp NULL
revokedAt timestamp NULL
```

### 5.3 依赖
- 官方 MCP SDK：`@modelcontextprotocol/server`（核心 server）、`@modelcontextprotocol/hono`（Hono 适配，提供 `createMcpHonoApp` + `WebStandardStreamableHTTPServerTransport`）。

---

## 6. 认证设计（个人 API Token）

### 6.1 token 生命周期
- `POST /api/user/tokens`：登录后生成，**明文只返回一次**；DB 只存 hash。
- `GET /api/user/tokens`：列出自己 token 元数据（不含明文）。
- `DELETE /api/user/tokens/:id`：吊销（置 `revokedAt`）。

### 6.2 MCP server 校验
MCP 请求头 `Authorization: Bearer <token>`：
1. 找不到 / 已吊销 / 过期 → 未授权；
2. 解析出 `userId` 注入工具上下文；
3. 所有工具只读写该 `userId` 数据。

---

## 7. 推荐新源实现策略

### 第一版（不做内置搜索）
- agent 搜索 → `validate_candidate` / `discover_feed` 核验 → `add_subscription`。
- MCP server 零外部依赖，只解析用户主动给的 URL，职责单一且安全。

### 增强版（后置）
- `recommend_sources` 读已订阅 feed 的 title/分类/条目关键词，与候选（公开目录/RSSHub 路由）做相似度，返回带理由的候选。
- 需内容向量化/检索层，属于较大工作。

---

## 8. 部署形态

### 主推：Streamable HTTP 远程服务
- `/mcp` 作为 RSSFed 后端端点（与 `/api` 同域），一个实例服务所有用户。使用官方 `@modelcontextprotocol/hono` 挂载 Streamable HTTP transport。
- 客户端配置：
  `{ "mcpServers": { "rssfed": { "type": "http", "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`

#### 端点尾部斜杠兼容性（重要）
- **服务端同时响应 `/mcp` 与 `/mcp/`（及子路径），且不返回任何 301/307 重定向**——两种写法都直接落到同一个 MCP handler。
- 原因：MCP 规范以无斜杠的 `/mcp` 为标准，但不同客户端/网关对尾部斜杠的处理不一致：
  - Cursor 等客户端有时会**裁剪配置里的末尾斜杠**（`/mcp/` → `/mcp`）；
  - AWS API Gateway 默认会**修剪尾部斜杠**；
  - Cloud Run 等平台可能**追加尾部斜杠**（`/mcp` → `/mcp/`）；
  - 最严重的是：若依赖 307 重定向，部分客户端跟随重定向时会**用不带 `Authorization` 头的 GET 重新请求**，导致 401 / OAuth 握手失败。
- **因此不做重定向，而是让两种形式等价直达**，是最稳妥的兼容做法。客户端无论配 `/mcp` 还是 `/mcp/` 都能直接连通，不触发任何重定向。

### 本地 stdio（调试）
- 提供 `npm run mcp` 启动本地 stdio server，共用同一套工具定义。

---

## 9. 分阶段落地计划

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **P0** | `api_token` 表 + 生成/列表/吊销 + 校验中间件 | ✅ 已完成 |
| **P1** | 抽 `services/feeds.ts` 共享层，补 `removeSubscription` | ✅ 已完成 |
| **P2** | 挂 `/mcp`，用 SDK 暴露工具，接认证 | ✅ 已完成 |
| **P3** | 订阅管理工具（list/add/remove/pause/resume/update/refetch/discover） | ✅ 已完成 |
| **P4** | Bot 工具（list/create/update/delete/add_feed/remove_feed/list_feeds/organize） | ✅ 已完成 |
| **P5** | 读取内容工具（get_feed/list_entries/search_entries） | ✅ 已完成 |
| **P6** | 推荐增强（可选，`recommend_sources` + 内容理解层） | ⏳ 待做（建议后置） |

---

## 10. 风险与决策点

1. **授权是最大风险**。MCP 工具绝不能暴露 admin 接口。必须走用户级服务函数，逐个校验归属。
2. **写路径与前端一致性**。MCP 写订阅必须写**同一种** CouchDB `subscription:{feedId}` 文档（`user-state` 库），否则前端 PouchDB 同步会识别不了、产生数据分裂。
3. **订阅与推荐分离**。`validate`/`discover` 只校验不订阅，避免 AI 一键塞入一堆未确认源。
4. **条目正文裁剪**。读内容工具默认只返回 title/summary/link，避免烧 token。
5. **Bot 是否允许关联未订阅的源**：建议限制为自己订阅的源。
6. **CouchDB 库名映射**。工具需通过 `user.couchDbName` / `feeds.couchDbName` 定位库，不要硬编码。

---

## 11. 结论

**方向正确、落地成本可控，且不破坏离线优先架构。** 关键设计：
- **前端不动**：订阅管理继续走 PouchDB ↔ CouchDB 离线同步。
- **MCP 复用现有模块**：工具直接调用 `parseFeedUrl` / `ensureFeedRegistered` / `enqueueFetch` / CouchDB 客户端等既有函数，只把私有函数抽到共享 `services/` 层并 export，不重写业务逻辑。
- **不新增一套 REST API**：MCP 工具不是"再调一个 HTTP 接口"，而是服务端函数调用；满足"想避免维护两套 API"的诉求。
- **写路径保持一致**：MCP 写 `subscription:{feedId}` 文档，与前端同步形态一致。

第一版建议先做 **P0 + P1 + P2 + P3**（token 认证 + 共享服务层 + MCP 骨架 + 订阅管理闭环），跑通「列出我的订阅 → 发现 → 添加 → 暂停 → 移除」，再扩展 Bot 与内容读取。

---

## 12. 未来开放 REST API 的路径（前瞻备忘）

> 现状与判断：
> - **MCP 已覆盖「AI 工具 / agent」场景**，且是该场景的事实标准（dsh、Claude Desktop、Cursor、Cline 等原生支持）。**若将来第三方是 AI 工具，MCP 即是答案，无需额外 REST。**
> - **目前没有「面向第三方普通工具、带 token 认证、用户级授权」的常规 REST API**。现有 `/api/*` 多数依赖 Better Auth 的 cookie session（浏览器登录态，第三方进程带不了），且 `GET /feeds`、`PATCH/PUT /:feedId`、`refetch` 是 `requireAdmin`（管理员级）。
>
> **决策：现在不提前实现普通 REST API（避免 YAGNI / 增加维护面）。等到确有非 AI 的第三方工具需求时，再按下面的低成本路径扩展。**

### 为什么将来扩展是低成本的

我们做 MCP 时抽出的**用户级服务层**（`services/feeds.ts`、`services/bots.ts`、`services/entries.ts`）和 **Bearer token 认证**（`services/api-token.ts`）正是 REST 也能复用的地基：
- 所有订阅/Bot/内容的**业务逻辑 + 用户归属授权**都已经在这层实现；
- REST 端点只需要把服务函数暴露为带 `Authorization: Bearer` 的 HTTP 接口即可，**业务逻辑不用重写、不会分叉**。

### 将来落地步骤

1. **新增版本化路由前缀** `app.route("/api/v1", v1Router)`（与现有 `/api/*` 区分，避免影响前端和 admin 接口）。
2. **认证中间件**：复用 `resolveTokenUser`（`services/api-token.ts`），在 `v1Router` 上统一校验 `Authorization: Bearer <token>`，解析出 `userId` 注入 context。
3. **暴露服务层为 REST 端点**，例如：
   - `GET  /api/v1/subscriptions` → `listSubscriptionsForUser(userId)`
   - `POST /api/v1/subscriptions` → `addSubscriptionByUrl(userId, url, category)`
   - `DELETE /api/v1/subscriptions/:feedId` → `removeSubscription(userId, feedId)`
   - `PATCH /api/v1/subscriptions/:feedId` → `setSubscriptionStatus` / `updateSubscriptionMeta`
   - `POST /api/v1/subscriptions/:feedId/refetch` → `refetchFeed`
   - `GET  /api/v1/bots`、`POST /api/v1/bots`、`POST /api/v1/bots/:id/feeds` … → `botService.*`
   - `GET  /api/v1/feeds/:feedId/entries`、`GET /api/v1/feeds/:feedId/entries?q=` → `entryService.*`
4. **契约版本化**：`/api/v1` 前缀 + 稳定的响应结构（`services/` 层返回的对象即约定），保证将来兼容。MCP 工具的 inputSchema 可作为 REST 参数校验的参照（或直接复用 zod schema）。

### 需要留意的点

- **不要复用 admin 路由**（`GET /feeds`、`PATCH/PUT /:feedId`、`refetch`）。这些是管理员级的全局操作；给普通用户的 REST 必须走 `services/` 的用户级版本（内含归属校验）。
- **保持与 MCP 一致**：REST 与 MCP 共用同一份 `services/` 业务逻辑，避免两边行为不一致。
- **前端仍不动**：即使将来开放 REST 给第三方，前端继续走 PouchDB ↔ CouchDB 离线同步，不依赖这套 REST。

> 结论：**现在不做，只是把地基打对。** 将来若有非 AI 的第三方工具，加一层 `/api/v1` REST 端点即可低成本复用现有服务层，业务逻辑与授权保持唯一一份。
