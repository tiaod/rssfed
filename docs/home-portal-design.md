# 首页门户化 + SSR：设计方案

> 目标：`/` 从「静态仪表盘」改成**公开可看的新闻门户式首页**，SSR 直出「今日内容」；排序先用时间序占位，后续交给大模型定期更新。
> 本文只做设计，不含实现改动。基线：当前工作树（HEAD `58052a3` + 未提交改动，`usePouchDb.ts` / `timeline.vue` 等有改动，`useUnreadFilter.ts` 尚未纳入版本控制）。

---

## 0. 已确认的决策

| 决策项 | 选择 | 带来的后果 |
| --- | --- | --- |
| 首页受众 | **公开全站热点**，未登录也能看 | 与个人订阅无关 → 不需要按用户聚合 N 个 feed 库；可加公共缓存；可做 SEO |
| 内容来源 | 先时间序占位，**后续由大模型定期更新** | 首页内容必须是**物化快照**（异步批处理天然产物），不能请求时现算 |
| 卡片配图 | **新增公开缩略图路由** | 要新增一个免认证、长缓存、有滥用防护的图片端点 |
| 布局 | **新建独立 portal 布局** | 首页不再挂个人侧边栏 → 该路由完全不碰 PouchDB，也避开了 SSR payload 的个性化问题 |

**这套组合把之前分析里最难的部分全部绕开了**：per-user 聚合的 N 源扇出、已读状态复活、SSR 与本地库的合并规则、SW 缓存个人 HTML —— 都不适用了。剩下的是「一个公开内容面该怎么建」，属于常规工程。

一句话架构：

```
Worker 定时作业（间隔 N 分钟）→ 选取候选条目 → 写 PG 快照批次 → 原子翻指针
                                                        ↓
Nuxt SSR 首页（portal 布局）── 1 次 PG 查询 ──▶ Hono GET /api/home/highlights（public + s-maxage）
                                                        ↓
                                              公开缩略图 GET /api/home/thumb/...（immutable）
```

关键点：**SSR 只查一次 PG**，不碰 CouchDB、不碰 PouchDB、不做扇出。所有重活在请求路径之外完成。

---

## 1. 数据模型

### 1.1 两张表 + 一个指针

```ts
// packages/hono-server/src/db/schema.ts

/** 首页快照批次：每次作业生成一版，保留最近几版以便回滚 */
export const homeBatches = pgTable("home_batches", {
  id: varchar("id", { length: 32 }).primaryKey(),      // 批次 id（时间戳+随机后缀）
  origin: varchar("origin", { length: 16 }).notNull(), // 'recency' | 'llm'
  itemCount: integer("item_count").notNull(),
  degraded: boolean("degraded").notNull().default(false), // 本次是否有降级（候选不足等）
  note: text("note"),                                  // 失败原因 / LLM 备注，排障用
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
})

/** 批次内的具体条目（展示所需字段冗余存储，首页不 join） */
export const homeHighlights = pgTable("home_highlights", {
  id: varchar("id", { length: 32 }).primaryKey(),
  batchId: varchar("batch_id", { length: 32 }).notNull(),
  position: integer("position").notNull(),              // 展示顺序
  entryId: varchar("entry_id").notNull(),               // CouchDB entry 文档 id
  feedId: varchar("feed_id").notNull(),
  title: text("title").notNull(),                        // 可被 LLM 改写
  summary: text("summary"),                              // v1 取原文摘要，LLM 可重写
  url: text("url").notNull(),                            // 原文链接
  sourceName: text("source_name"),                       // 冗余源名，避免首页 join
  imageAttachment: varchar("image_attachment", { length: 128 }), // 附件名，无图则 null
  imageDigest: varchar("image_digest", { length: 64 }),  // 用于 ETag
  publishedAt: timestamp("published_at").notNull(),
  origin: varchar("origin", { length: 16 }).notNull(),
  reason: text("reason"),                                // LLM 的入选理由（v1 为空）
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => ({ batchPos: index("home_highlights_batch_pos_idx").on(t.batchId, t.position) }))
```

指针放在 `site_settings` 的一个字段里（`home_active_batch_id`）或单独一行配置；用指针而不是「查最新批次」是为了**切换原子、可回滚**：新批次写完 → 翻指针 → 清理旧批次。作业中途失败时首页仍指向上一版。

### 1.2 为什么是快照而不是请求时现算

1. **SSR 只查一次 PG**，TTFB 与本机查询同量级，永远不会因为源站慢而拖垮首屏；
2. LLM 策展本身就是异步批处理，快照是它的自然产物，不用为它二次改造接口；
3. 批次可回滚、可审计（能回答「今天首页为什么是这几条」）；
4. 顺带解决「N 源扇出」：扇出只发生在作业里，失败重试不影响用户。

> 关于扇出规模：626 订阅规模下，近 1 小时有更新的源只有 26 个、近 1 天 208 个（`report/sync-diagnosis/RESULTS.md:53-56`）。所以候选集最多约 200 个源 × 每源 1 次视图查询（用 `include_docs=true` 一次拿到文档），并发 5~8（照 `feeds.ts:101` 的 `mapWithConcurrency` 先例），一次作业是几百次 CouchDB 请求、跑的间隔是分钟级 —— 完全可以接受。

---

## 2. 作业管线（v1 时间序 → 后续 LLM 策展）

### 2.1 v1：时间序占位

```
1. 候选源：PG 查 feeds where status='active' and lastNewEntryAt > now() - interval '24 hours'
2. 每源取条目：CouchDB feed 库 `_design/main/_view/entries-by-date?descending=true&limit=3&include_docs=true`
3. 汇总 → 过滤掉没有 title/url 的脏文档 → 按 publishedAt 倒序
4. 每个源最多保留 2 条（保证多样性，避免单源刷屏）
5. 取前 N 条（N = 30）→ 写新批次 + 条目行 → 翻指针 → 删旧批次
```

排序语义在 v1 就是**「今日最新」**。因此首页文案不要写「最热」——等 LLM 上线再改措辞（避免名不副实）。

### 2.2 后续：LLM 策展（同一管线，多一个步骤）

```
候选集（~60–100 条：title / sourceName / summary / publishedAt）
   → LLM：排序 + 挑选 + 可选改写标题与摘要 + 给出入选理由
   → 校验（关键）：返回的 entryId 必须都在候选集内；url 一律用候选集的原始值，不采信模型输出
   → 写批次，origin='llm'，逐条写 reason；原文响应体留存到 note 或单独日志便于审计
   → 任一步失败/超时/校验不通过 → 回退：保留上一批次，本次记为 degraded
```

**为什么必须校验 entryId**：缩略图路由靠 entryId 找附件（§3），幻觉出来的 id 会直接让图 404；同时模型不得改写 URL（否则成为钓鱼面）。

### 2.3 调度与可观测

- 现成形态是 `setInterval(scheduleFeedFetches, FETCH_INTERVAL)`（`workers/index.ts:352`，`FETCH_INTERVAL` 默认 15 分钟）。快照作业有两条路：
  - **推荐**：BullMQ 重复任务（`Queue` 已在用，BullBoard 已挂在 `/admin/queues`）→ 重试、失败可见、可手动触发，且将来多副本不会重复跑；
  - 省事：再加一个 `setInterval`（与现有模式一致，但重启会丢调度、无重试）。
- **启动时预热一次**：不能等第一个 tick，否则部署后首页有最长一个间隔的空窗。
- 失败一律**保留上一批次**，首页永远有内容。
- 间隔建议 10~30 分钟（LLM 阶段可按 30~60 分钟，配合成本）。

---

## 3. 接口契约

### 3.1 `GET /api/home/highlights`（公开）

```
GET /api/home/highlights?limit=30
200 {
  generatedAt: "2026-10-02T09:30:00.000Z",
  origin: "recency" | "llm",
  degraded: false,
  items: [{
    position: 0, entryId, feedId, title, summary,
    url, sourceName, publishedAt,
    imageUrl: "/api/home/thumb/<feedId>/<entryId>?v=<digest>" | null
  }]
}
Cache-Control: public, s-maxage=300, stale-while-revalidate=900
```

- 无需认证（照 `/api/bots/public`、`/api/site-settings` 的先例）。
- `limit` 上限钳到 50，防止被当成分页接口刷。
- 快照缺失时返回 `items: []` + `degraded: true`（不 500、不 404），前端显示「今日内容正在生成」并给出「去时间线」入口。
- `imageUrl` 里带 `?v=<digest>`：内容变了 URL 就变，可以放心用 immutable 缓存。

### 3.2 `GET /api/home/thumb/:feedId/:entryId`（公开图片）

设计要点：

| 项 | 做法 |
| --- | --- |
| 取图 | 快照里已存 `imageAttachment`，据此读 CouchDB 附件（`feed_{db}` 由 `feedId` 查 PG 得到库名）→ 流式返回 `image/avif` |
| **访问控制** | 只允许**当前批次快照里存在的 entryId**，其余一律 404。把可访问集合收敛到几十条，而不是开放整个 CouchDB 附件空间 |
| 缓存 | `Cache-Control: public, max-age=31536000, immutable` + `ETag: <imageDigest>`（命中 `If-None-Match` 返回 304） |
| 头 | `X-Content-Type-Options: nosniff`；不复用用户的会话，忽略 Cookie |
| 失败 | K 找不到附件/库 → 404；不要回退到原始外链（否则又变成可被滥用的图片代理） |
| 滥用 | 现有后端**没有任何 rate limit**。可访问集合已收敛（~30 条）+ immutable 缓存能吸收绝大部分流量；如需更严，加一个进程内按 IP 的令牌桶（单副本是当前部署的既有前提，见 Caddyfile 备注） |

成本：缓存未命中 = 1 次 PG（feedId→库名）+ 1 次 CouchDB 附件读。命中后由浏览器/CDN 承担。

### 3.3 管理端

- `POST /api/admin/home/refresh`（`requireAdmin`）：立即重算一次，用于 LLM 上线后的手动策展/排障。
- `GET /api/admin/home/batches?limit=5`：看最近几版批次（origin / itemCount / degraded / note），配合 BullBoard 定位问题。

---

## 4. 前端

### 4.1 portal 布局（`app/layouts/portal.vue`）

- 顶栏：站点 logo/标题（`useSiteSettings`，客户端 bootstrap，SSR 用默认值 —— 与 `app.vue` 现状一致）+ 导航（首页 / 时间线 / Bot 广场 / 收藏）+ 登录按钮或头像。
- **不含** `UDashboardSidebar` / `FeedNavigation` / `EntryDetailModal`（这些依赖 PouchDB 与本地库）。
- 好处：首页路由不会加载 PouchDB 相关 chunk；SSR 阶段也没有任何个人数据来源。
- `/timeline` 等页面继续用现有 `default` 布局，互不影响。

### 4.2 首页结构（重写 `app/pages/index.vue`）

```
definePageMeta({ layout: 'portal' })
useAsyncData('home-highlights', () => $fetch('/api/home/highlights'), { server: true, default: () => ({ items: [] }) })
```

版面（v1）：

- **头条区**：第 1 条，大卡（图 + 标题 + 源名 + 相对时间）
- **列表区**：第 2~N 条，两栏或三栏栅格（移动端单列）
- **空/降级态**：`degraded || items.length === 0` → 「今日内容正在生成」+ 「去时间线」
- 底部固定入口：「进入我的时间线」

`useSeoMeta` 补标题/描述/`og:*`（门户页是唯一有 SEO 价值的页面）。

**组件不要复用 `EntryCardItem`**：它依赖本地库补出来的 `coverUrl`（blob）与 enriched `feed` 元信息。首页要新建纯 props 组件（如 `HomeLeadCard.vue` / `HomeItemCard.vue`），只吃接口字段。

### 4.3 点击行为（一个容易被忽略的落差）

门户里的条目**不在用户的本地 PouchDB 里**（首页是公开内容，与个人订阅无关），所以：

- 主行为：**新窗口打开原文 URL**（`target="_blank" rel="noopener noreferrer"`）；
- 次行为：给「在应用内阅读」入口 → 若该 feed 已订阅则跳 `/rss/feed/{feedId}`，否则跳订阅发现流程。

不要试图直接弹 `EntryDetailModal`：它读本地附件与已读状态，对未同步的条目只会空转。

### 4.4 现有仪表盘内容

`/` 现在是「欢迎语 + 三张卡片」，改成门户后建议直接删除（导航里已有「我的」）。若要保留，挪到 `/profile`。

---

## 5. 缓存与隐私：一条硬约束

⚠️ **首页 HTML 不能进缓存/CDN，除非先解决 payload 里的会话。**

`plugins/auth-session.ts` 是全局插件，会把 better-auth 会话写进**每个** SSR payload（为了消除 UserMenu 的 hydration mismatch）。一旦给 `/` 加 Nitro `routeRules: { '/': { swr: … } }` 或前面挂 CDN，缓存的 HTML+payload 就会把 A 的用户信息发给 B。

v1 规则：

- **缓存数据，不缓存 HTML**：`/api/home/highlights` 由 Hono 出 `public, s-maxage`；Nuxt 侧不加 HTML 缓存。单次 PG 查询足够便宜，首屏不依赖 HTTP 缓存。
- 将来若确实要 HTML 级缓存（门户站的标准做法），前置条件是：让 auth-session 插件在 `/` 上不预取会话（首页个人态全部改客户端渲染），并加一条「payload 不含用户字段」的回归检查。

### Service Worker

- 导航 HTML 是网络优先 + 落缓存（`sw.js:153-159`）：首页内容是公开的，**离线命中旧首页没有隐私问题** —— 这是选公开路线的红利。
- 建议把 `/api/home/highlights` 加进 `API_CACHE_PATTERNS`（网络优先，断网读上次快照）；
- `/api/home/thumb/*` 用 **cache-first**（内容带 `?v=digest` 不可变）。
- `sw.js:202-214` 那段「数据通道一律交给 PouchDB、不碰 /api/**」的注释需要补一句边界说明：新增缓存的两条是**公开**数据，个人数据（`/api/couchdb/proxy/*`）仍然放行不缓存。

---

## 6. 里程碑与工作量

| 里程碑 | 内容 | 估时 |
| --- | --- | --- |
| M1 | PG 两张表 + 快照作业（v1 时间序）+ 公开接口 + 启动预热 + 降级 | 1.5–2 人日 |
| M2 | 公开缩略图路由（含白名单、ETag、immutable 缓存） | 0.5–1 人日 |
| M3 | portal 布局 + 首页重写 + SEO + 空/降级态 | 1.5–2 人日 |
| M4 | SW 缓存策略 + 验收脚本（含禁 JS 的 SSR 校验） | 0.5 人日 |
| M5 | LLM 策展（候选集 → 模型 → 校验 → 写批次 + admin 手动触发/审计） | 1.5–2 人日 |

M1–M4 合计约 **4–5.5 人日**可上线；M5 独立排期（M1 的表结构里 `origin` / `reason` 已为它留好位置，不需要改表）。

建议顺序：**M1 → M3**（先让首页有内容、可看），M2 图片与 M4 离线紧跟，M5 最后。

---

## 7. 验收清单

**SSR 的核心验收（必须做）**

```bash
# 禁用 JS 也能看到内容 —— 这才是「首页 SSR」真正要证明的事
curl -s http://<host>/ | grep -o "<首条标题>" | head -1
curl -s http://<host>/ | grep -c "home-thumb"
# 首页响应头不应带 public 缓存（避免将来被 CDN 误缓存个人 payload）
curl -sI http://<host>/ | grep -i cache-control
```

**其它**

| 项 | 期望 |
| --- | --- |
| 未登录访问 `/` | 正常渲染内容（不需要会话） |
| 首屏性能 | 冷 Nitro + 冷浏览器：TTFB / LCP 目标先在本地测一版基线再定（门户页没有 PouchDB 阻塞，量级应明显优于 `/timeline`） |
| 快照新鲜度 | ≤ 作业间隔 + 5 分钟 |
| 作业失败 | 首页仍显示上一批次；`degraded` 状态不导致白屏 |
| 接口不可用 | SSR 不 500：渲染骨架 + 客户端重试入口 |
| 缩略图 | 正确的 `Content-Type: image/avif`；二次请求 `304`（ETag）；非快照 entryId → 404 |
| 移动端 | 栅格在 640/768/1024 断点正常；暗色模式（Nuxt UI）无对比度问题 |
| SW | 断网重开 `/` 显示上次快照；缩略图离线可用 |
| payload 检查 | dev 下确认首页 payload 未被任何 HTTP 缓存（M5 若开 HTML 缓存，此项变前置条件） |

---

## 8. 明确不做 / 已知取舍

1. **不做个人化时间线播种**（已放弃）：首页与个人订阅解耦，`/timeline` 保持现状。
2. **不做 HTML 级缓存**（前置条件未满足，见 §5）。
3. **不把首页内容写进本地 PouchDB**：门户是只读公开内容面，离线靠 SW 缓存。
4. **首页不渲染正文**：正文净化在服务端返回空串（`useSafeHtml.ts:69-77`），且门户的性质就是「标题 + 摘要 + 跳原文」。
5. **v1 文案不写「最热」**：时间序就是「最新」，等 LLM 上线再改。
6. **LLM 不得生成候选集之外的条目**：entryId 必须校验（缩略图与跳转都依赖它），URL 一律用候选集原值。
7. 首页**不显示已读/未读**：那是个人态，属于 `/timeline`。

---

## 附：首页为什么不需要 PouchDB 侧的防护

有一类高风险项只属于「让 SSR 渲染**个人**数据」的方案（曾经评估过的「SSR 播种时间线」路线，已放弃）：PouchDB 在服务端不报错而是静默落库、`useCouchTargets` 模块级缓存跨请求串号、种子与本地库的合并规则、SW 缓存个人 HTML。首页改成公开内容面后，这些全部不适用：

- portal 布局不 import PouchDB 相关 composable → 服务端没有可落到 LevelDB 的调用路径（`usePouchDb.ts` 顶层 `import PouchDB` 会把 leveldb 适配器打进 Nitro 产物，`new PouchDB()` 在 Node 下会静默在磁盘建库）；
- 不调用 `remoteUrlForId` → 不触发 `useCouchTargets` 那个跨请求共享的模块级缓存（库名按账号绑定，SSR 复用会串号）；
- 首页 HTML 里没有个人数据 → SW 缓存与 CDN 缓存都安全。

**唯一需要长期保持的纪律**：首页（portal 布局）永远不要引入 PouchDB / 会话相关的 SSR 数据源。这条纪律建议写进 `ARCHITECTURE.md` 的首页一节。
