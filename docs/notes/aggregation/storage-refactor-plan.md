# 存储层重构方案：按需复制 + 时间窗口清理 + 状态库独立

> **状态：提案，待确认。未落地。**
> 本文是重构设计稿，**不是现行规范**。落地后只有不变量并入 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)，
> 实现细节留在代码注释里。
> 前置实测结论：[`couchdb-replicator-aggregation.md`](couchdb-replicator-aggregation.md)（复制语义 5 条边界）、
> [`on-demand-replication.md`](on-demand-replication.md)（常驻复制被打崩 → 按需 + 水位）、
> [`sync-window-anchor.md`](../sync/sync-window-anchor.md)（复制 id 与窗口锚点）。
> **本次是重构：不做历史数据迁移，服务端与客户端旧数据一律清空。**

> **已定**：复制按需触发；源库按时间窗口 purge（删除不进复制）；订阅意图与已读收藏放独立状态库；
> 冲突保留最新修改；共享载体是独立 `channel:{id}`；Bot 投影库是 `bot_feed:{id}`；
> 汇聚库墓碑**靠 `_purge` 清、不用换代**；**客户端不做本地清理、不做整库重置**；
> Bot 完整数据改放 PostgreSQL（标准 BotKit）。
>
> **本轮已完成（加法式，未接进 worker 运行路径）**：§13 的四个探针已跑完并留档；
> `packages/hono-server/src/couchdb/retention.ts` + 19 个单测已落地（源库/投影库窗口 purge、
> 汇聚库窗口 delete、墓碑账本按宽限期 purge）；探针脚本在 `packages/hono-server/scripts/probes/`。

## 0. 一句话

源库与汇聚库各留 `N` 天，**由服务端统一清理**（源库直接 purge 活文档、不产生删除；
汇聚库先 delete 让删除投递给客户端、宽限期后再 purge 墓碑）；
复制只负责"把源库窗口内的新文档搬下去"（**静态 selector，无时间谓词，删除不参与**）；
用户意图（订阅、已读、收藏）放独立状态库，永不清理；
**内容包的完整数据在 PostgreSQL，CouchDB 只承载可重算的离线阅读投影。**

## 1. 要的 / 付出的

**要的**：两端都有界；没有常驻复制任务；没有 per-user 窗口、没有剪枝扫描、
没有"放大窗口要回填"这套机制；删除语义**完全不用设计**（删除不进复制）；
**客户端只镜像、不做任何清理判断**（浏览器时钟与本地调度不再参与过期认定）。

**付出的**（记账，写在明处）：

1. **源库与汇聚库的清理必须保序**（源库先、汇聚库后），否则出现"删了又回来"的复活循环（§5.4）。
2. **用户驱动的删除要各端自己执行**（退订/删源），不能靠复制传播（§5.5）。
3. LWW 依赖客户端时钟（§8）。
4. 客户端第一次拉取的量 = 汇聚库窗口内的全部内容（含附件），`N` 直接决定它（§10 风险 4）。
5. **Bot/内容包是"PG 权威 + CouchDB 投影"双存储**：投影必须可幂等重算，否则会出现
   "PG 有、离线看不到"且没人发现（§7）。
6. **客户端本地只增不减**（不 purge、不重置）：过期内容与墓碑会留下，必须靠 `compact()` 回收附件与旧修订（§6）。

## 2. 新不变量

1. **窗口只有一个来源**：服务端计算 `retention_bound = 服务端时刻 − N 天`，落库并随同步下发。
   客户端不得用本机时钟现算 `now − N`（`sync-window-anchor.md` 实测：跟着时钟走的 selector
   会让复制 id 每天变一次）。**客户端根本不参与过期认定**，只用服务端下发的 bound（如果需要）。
2. **清理保序**：源库先清、汇聚库后清（保留期 `N < N+δ1`）。**汇聚库不得比源库更早认定过期**。
3. **复制只搬新增**：静态 selector `{"type":"entry"}`（仓库实际的文档类型是 `entry` / `feed`，时间字段是 `publishedAt`），无时间谓词、无 `query_params`
   → 复制 id 永久稳定、checkpoint 永久复用。删除标记不参与复制。
4. **只有服务端做清理**（源库 purge、汇聚库 delete + 宽限期后 purge 墓碑、compact）；
   客户端只镜像，不做 TTL purge、不做墓碑 GC、不做整库重置。
5. **用户意图驱动的删除各端自己执行**：服务端删汇聚库副本 + 删水位行，客户端删本地。
6. **一用户两库**：汇聚库（内容副本 + 源清单，服务端写、客户端只读）与
   状态库（`subscription:` / `entry-state:` / `group-pref:`，客户端写、双向、永不清理）。
7. **状态与文章解耦**：文章被清掉不影响状态文档，不做级联删除。
8. **冲突按"保留最新修改"**：客户端可写文档带 `updatedAt`，冲突时保留最新一版并显式删除输的分支。
9. **没有 per-user 窗口**：`windowDays` / `minFeedEntries` 整套消失；`N` 是服务端配置
   （全局默认 + 可按源/内容包覆盖）。
10. **PostgreSQL 是 Bot 与内容包完整数据的权威**，CouchDB 只承载**可重算的离线阅读投影**；
    投影丢失/损坏可从 PG 重建，不需要备份投影。

## 3. 库拓扑

```
feed:{feedId}              源库       抓取产物，保留 N 天，客户端不直连
   │
   ├── 私人聚合 ─────────────────┐
   │                             │  按需复制（静态 selector，只搬新增）
   ├── 内容包 ──▶ channel:{id} ──┤
   │             共享内容包投影   │
   └── Bot 产出 ─▶ bot_feed:{id} ┘
                   Bot 离线投影
   ▼
user:{userId}              汇聚库     内容副本 + 源清单 ← 服务端写（validate_doc_update 只放行 admin）
state:{userId}             状态库     subscription: / entry-state: / group-pref: ← 客户端写，永不清理

浏览器
rssfed-articles-<uid>      镜像（live pull，不带 selector；不做本地清理）
rssfed-state-<uid>         双向 live sync
```

- `channel:{id}` 与 `bot_feed:{id}` **机制完全同构**（都是"PG 权威 → CouchDB 投影 → 被按需复制进汇聚库"），
  只是命名与用途分开：前者是共享内容包，后者是 Bot 的对外产出投影。
  若以后想把 Bot 产出也当内容包共享，直接按 channel 语义使用即可，不需要迁移。
- 库名继续用**随机小写名 + PostgreSQL 登记**（`feeds.couch_db_name` / `user.timeline_db_name` 那套）：
  `feedId = sha256(url).base64url` 含大写字母、且约 1/64 以 `_` 开头，直接拼进库名会被 CouchDB 拒。

## 4. 复制（只搬新增）

### 4.1 selector 是静态的

```json
{ "source": "<feed_db 或 channel_db / bot_feed_db>", "target": "<user_db>",
  "selector": { "type": "entry" } }
```

- **不要放时间范围**。源库/投影已经按同一个窗口清理过了，复制层再放一个时间谓词是第二套权威；
  而且它必然随窗口变化 → 复制 id 变 → 从 0 重扫（`couchdb-replicator-aggregation.md` 结论 3、
  `sync-window-anchor.md`）。源库"待清理"的过期文档最多多搬一个清理周期，比参数抖动便宜得多。
  → 因此**顺序上先清源库、再跑复制**（§5.3）。
- selector 传不了删除（结论 1）—— 这正是本方案要的：删除不进复制。墓碑没有 `type`，被自然挡掉。
- 设计文档（`_design/*`）没有 `type`，也被挡掉。这一条是**脆性前提**：源库任何新文档类型都必须
  显式带 `type`，否则会被静默丢弃。要在设计文档里写死这条约定。

### 4.2 水位与触发

PostgreSQL 一张表（沿用 `timeline_source_sync` 的位置）：

```
(user_id, source_kind, source_id) → synced_at, last_source_seq, selector_version, status, error
```

`source_kind` = feed | channel | bot_feed。

脏源判据：**没有水位行 ∨ 上次失败 ∨ `selector_version` 变了 ∨ 源有新增**。
「源有新增」比的是 `source.last_new_entry_at > 上次同步开始时刻`（记开始时刻是为了不丢复制进行中写入的条目）。

- **不需要 `last_changed_at`**：删除不进复制，所以"只删不增"不必触发同步
  （这是相对"删除传播"方案省掉的一列）。
- 执行：`POST /_replicate` + `continuous:false`，同步等待完成；不塞 `_replicator`
  （调度器的 `max_jobs`/`max_churn` 会饿死）。
- 限速：同一 (用户×源) **单飞**；队列并发上限；**首轮导入几百个源要排队**。
- 拆除：退订 → 删水位行 + 删该源在汇聚库的条目（§5.5）。

## 5. 保留与清理（全部在服务端）

### 5.1 参数

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `N` | 30 天 | 保留窗口；全局默认 + 可按源/内容包覆盖（`feeds.retention_days`、`channels.retention_days`） |
| `δ1` | 1 天 | 汇聚库比源库多留的时间，用来保证"源库先清、汇聚库后清" |
| `G` | 7 天 | **墓碑宽限期**：过期删除发生的 `G` 天后，墓碑才允许被 `_purge` |

`retention_bound = now − N`，**服务端算一次**并落库；客户端如果要用，只能用服务端下发的值。

### 5.2 purge 的正确姿势（比原设计少两步）

- **CouchDB 可以直接 purge 活文档**，不必先删除：
  官方 `_purge` 文档原文 "Documents can be previously deleted, but it is not necessary.
  Revisions must be leaf revisions."
  → 从 `_all_docs` / `_find` 拿 `{_id, _rev}` 直接 `_purge`，
  **省掉"先标准删除"和"扫 `_changes` 找墓碑"两步**（源库用这条）。
  ✅ **已实测（§13.A）**：201 成功、文档从 `_all_docs` 与 `_changes` 同时消失、`_changes` 里
  不留"取不到 rev"的行。
- **冲突分支要一起 purge**：只 purge winner 会留下 loser 分支，文档还在。
  ✅ 已实测（§13.A）：purge winner 后 loser 顶上、文档仍可 GET；把所有叶子一起 purge 才彻底消失。
  用 `_all_docs?conflicts=true&include_docs=true` 把它一起带上。
- `_purge` 要 admin 权限；批量 ~1000 条/次。
- **purge 之后必须 `_compact`** 才能真正回收磁盘（配 `[compactions]` 自动，或定时）。
- 例外：**汇聚库故意保留"先 delete 后 purge"**，墓碑要用来把过期事件投递给客户端（§5.3、§5.6）。

### 5.3 两端的调度与顺序

| 层 | 保留期 | 清理动作 | 节奏 |
| --- | --- | --- | --- |
| 源库 / 投影库 | `N` | **直接 purge 活文档**（不产生删除） | 每天，**在复制之前** |
| 汇聚库 | `N + δ1` | **先 delete**（墓碑立刻复制给客户端） | 每天，源库之后 |
| 汇聚库墓碑 | — | 删除满 `G` 天后 `_purge` + `_compact` | 每天 |
| 客户端 | — | **不清理**，只镜像；仅 `compact()` 回收附件与旧修订 | 按需 / 定时 |

顺序纪律：**源库之后才轮到汇聚库**。`δ1` 就是为此留的（两端都在服务端，共用同一个 bound，
所以这一对不会漂移）。

✅ 另外已实测（§13.B）：**源库 purge 不会让复制的 checkpoint 失效** —— purge 之后同参数复制
仍然从上次序号续读（用"目标端 purge 一条、看它会不会被搬回来"的判别法验证，并有阴性对照）。
所以"每天 purge"不会退化成"每天全量重扫源库"。

### 5.4 为什么清理要保序（写在明处）

- 汇聚库比源库更早清掉文档 X → 源库里 X 还是**活文档** → 下一次复制把 X 搬回来
  → 用户看到"删了又回来"。selector 复制不搬删除，**没有任何机制能阻止它**，而且会每轮重复。
- **客户端不清理之后，这条约束只剩源库↔汇聚库这一对**，而这两个都在服务端、共用同一个
  `retention_bound`、只差一个 `δ1` —— 浏览器时钟与本地调度不再参与过期认定，
  最容易漂移的一环被消掉了。这是"客户端不做本地清理"最大的收益。
- 反过来说：以后**不要**给客户端加"本地 TTL 清理"，除非同时把 §2.2 的保序扩展成三端。
  PouchDB 官方也把 `purge` 定位成 admin 用途而非常规删除手段（它会抹掉修订记忆，
  之后任何一次重扫都会把服务端还在窗口内的文档重新下回来，含附件）。

### 5.5 用户驱动的删除（退订 / 删源）

服务端：删汇聚库副本 + 删水位行；客户端：本地删该源的条目（它自己就有订阅意图）。
两边各自执行。**这是"删除不进复制"必须补的上半场**，否则退订后内容要挂到自然过期。

### 5.6 汇聚库墓碑：靠 `_purge` 清，不换代

**墓碑账本**（推荐实现，避免每次扫 `_changes`）：删除时把 `(user_id, doc_id, rev, deleted_at)`
写进 PG 一张表（`pending_purge`），删除动作的来源有两处：§5.3 的过期删除、§5.5 的退订删除。

- 清墓碑的任务：取 `deleted_at < now − G` 的记录 → 按 `{doc_id: [rev]}` 批量 `_purge` → `_compact`。
- `G` **必须覆盖客户端最长离线时长**：墓碑是"这条内容过期了"投递给客户端的**唯一渠道**，
  客户端离线超过 `G` 就会错过它、并永久保留那份已经过期的内容（离线优先下可接受，
  但要在监控里能看到"错过删除的设备数"）。
- purge 响应里会列出真正被清掉的 rev；没清掉的（rev 已不是叶子、或已被清）从账本里丢弃或重取，
  **不要当错误无限重试**。
- **不换代**：清墓碑由 purge 负责；现有"重建/换库"作为手动排障能力可以留着，
  但不再是保留策略的一环。
- 可选升级（现在不做）：客户端在状态库写 `client-ack:<deviceId> → { purgedBefore }`，
  服务端取**活跃**设备的最小值当判据（真判据，但要处理长期离线设备挡住 GC 的问题）。

## 6. 客户端

- 本地库名换新（`rssfed-articles-<userId>` / `rssfed-state-<userId>`），启动清旧库
  （复用现有 `cleanupLegacyDbs`）—— 对应"直接清库、不迁移"。
- 通道一：`replicate.from(汇聚库, { live:true, retry:true })`，**不带 selector**。
  这样汇聚库的删除（过期删除 + 退订删除）会**自动到端**，客户端即时缩水；
  也少一个会随窗口漂移的复制参数。
- 通道二：`sync(状态库, { live:true, retry:true })`，双向。
- **不做本地清理、不做墓碑 GC、不做整库重置**（§2.4）。
- **但必须 `compact()`**：删除只产生墓碑，条目的**附件**（图片）与旧修订仍占着 IndexedDB；
  不 compact 的话本地会随过期文章的图片单调增长（附件是体积主体，仓库的图片预算是 1MB/篇）。
  `compact()` 只回收旧修订与附件、**不动修订记忆**，与 `purge` 是两件事 —— 不会引起 §5.4 的复活。
  建议用定时 `db.compact()`，而不是 `auto_compaction: true`（后者每次写都重写，移动端代价高）。
  ✅ 已实测（§13.C）：`compact()` **不动修订记忆** —— 删 20 条 + compact + 擦 checkpoint 强制重扫，
  20 条一条都没回来。⚠️ 同一探针还量到：**leveldb 适配器未实现 `purge`**（直接抛错），
  所以 Node 侧的 PouchDB（单测、`verify-*.mjs`）不能用 `db.purge()`，只有浏览器 IndexedDB 支持。
- 换库/重置检测保留：远端库名一变就丢本地文章缓存重拉。
- 同步状态 UI（折叠"已同步 N 条"、进度、失败熔断）全部保留 —— 它挂在 live 事件上，通道没变。

## 7. 内容包与共享：channel / bot_feed

**统一模型：一份内容包 = PostgreSQL 存完整数据与定义，CouchDB 存可重算的离线阅读投影。**

| | 存哪 | 内容 |
| --- | --- | --- |
| 定义与元数据 | **PostgreSQL** | 创建者、源清单（引用哪些 feed/上游）、可见性、保留配置 |
| 完整产出数据 | **PostgreSQL** | Bot：身份、密钥、关注者、完整产出（标准 BotKit）；channel：聚合元数据 |
| 离线阅读投影 | **CouchDB** `channel:{id}` / `bot_feed:{id}` | 标题、摘要或正文、发布时间、原文链接、附件 |

- **投影必须可从 PG 幂等重算**（worker 从 PG 派生 + 重试 + 可重放）。否则会出现
  "PG 有、离线看不到"，而且没有地方会报错。
- outbox 查询改走 PG：现有 `routes/bots.ts` 的 `entries-by-date` 视图退场，
  需要给 PG 建按 `publishedAt` 的分页索引。
- **共享怎么发生**：把 channel 加进自己的订阅意图（状态库）→ 服务端把该 channel 的投影内容
  按需复制进自己的汇聚库 —— 与现有"用户订阅 Bot，用户库以 Bot 产出库为源复制"完全同构，
  §4 的复制机制**不需要改**。
- **扇入收益**：一个引用 M 个 feed、被 K 个用户订阅的 channel，复制次数是 `M + K`，
  而不是 `M × K`。
- 权限：投影库只读放行 `user` 角色（沿用 feed/bot 库的 `_security` 模式），写只有服务端。

> ⚠️ 这**反转**了 `ARCHITECTURE.md` 的一条现行不变量（"Bot 的产出也不在 PostgreSQL"），
> 落地时必须同步改该节，以及 `routes/bots.ts` / `workers/index.ts` 的写入与查询路径。

## 8. 冲突：保留最新修改

CouchDB 的赢家规则是确定的**修订树**规则（rev 深度/哈希），**不是按时间**；冲突分支会一直保留，
PouchDB 也不自动解。所以必须自己实现：

- 所有客户端可写文档带 `updatedAt`（ISO 8601 UTC）。
- 读到 `_conflicts` 时比较各分支的 `updatedAt`，保留最新的一版，把输的分支显式写 `_deleted:true` 收敛。
  客户端做，服务端跑同一个裁决任务兜底。
- 不用 `validate_doc_update` 拒绝过期写（会依赖客户端时钟单调，慢钟设备被永久拒写）。
- 代价记账：LWW 依赖客户端时钟；并发改同一条文档的**不同字段**时会丢字段
  （`read`/`starred` 同居一条文档）—— 接受。

## 9. 改动清单

**新增**：`couchdb/retention.ts`（源库/投影库窗口 purge + 汇聚库过期删除）、
`pending_purge` 表与墓碑清除任务、状态库建库/设计文档/闸门、
`feeds.retention_days` / `channels.retention_days`、冲突裁决、
`channel:{id}` 与 `bot_feed:{id}` 投影库及 PG 侧定义、Bot 投影 worker（从 PG 派生）、
PG 侧 outbox 分页索引、客户端定时 `compact()`。

**删除**：`windowStartIso` / `looserBoundIso` / `retentionBoundIso` / `readSourceFloor` /
`pruneOutsideRetention` / `pruneOlderThan` / `pruneBelowPerFeedFloor` / `deleteDocsByIds` /
`restoreTombstonedEntries` / `normalizeBoundIso` / `replicationQueryParams` /
`TIMELINE_REPLICATION_FILTER_QUERY_PARAM` / 汇聚库的 `timeline-maintain` 两条视图
（**`validate_doc_update` 必须保留**）/ `routes/bots.ts` 的 `entries-by-date` 视图查询。

**schema**：删 `user_timeline_settings` 整表；删 `timeline_source_sync` 的
`window_days` / `min_entries` / `bound_iso`；新增 `feeds.retention_days`（可空）、
`channels`、`pending_purge`；`feeds.last_new_entry_at` 保留（不再需要 `last_changed_at`）。

**前端**：profile 页窗口/保底条数档位删掉；本地库名换新 + 清旧库；订阅读写改到状态库；
退订时本地自己删该源条目。

## 10. 风险

| # | 风险 | 处理 |
| --- | --- | --- |
| 1 | **源库/汇聚库清理失序 → 复活循环**（静默、每轮重复） | §5.4 写成不变量 + 回归用例（故意让汇聚库先清，断言会复活 → 把机制钉住） |
| 2 | 首轮导入 / 上线重扫的复制爆发（当年压垮 2 核机的场景换马甲） | 单飞 + 队列并发上限 + 首轮排队；监控 `queued` |
| 3 | selector 依赖"每个文档都带 `type`"这个脆性前提，不带就被静默丢弃 | 写进源库设计文档注释 + 断言新文档类型必须带 `type` |
| 4 | `N=30` 天 × 几百个源的**首次拉取量**（含附件）可能到 GB 级 | 先量"30 天窗口下单个大账号汇聚库的体积"再定 `N`；客户端分段/按需拉取 |
| 5 | **客户端本地只增不减**（不 purge/不重置） | 必须 `compact()`（回收附件与旧修订）；监控 IndexedDB 体积；墓碑行本身很小（~百字节/条） |
| 6 | 墓碑在客户端离线超过 `G` 时被清 → 该设备永久保留一份过期内容 | `G` ≥ 最长离线时长；监控"错过删除的设备数" |
| 7 | **Bot/内容包双存储不一致**：PG 写了、投影没写 → 离线看不到且无人发现 | 投影由 worker 从 PG 幂等派生 + 重试 + 可重放；加"PG 与投影条数对账"监控 |
| 8 | outbox 改从 PG 读：分页/排序/去重语义与原来 CouchDB 视图不一致 | 建 `(bot_id, published_at)` 索引；对账 outbox 与投影的同一条内容字段一致 |
| 9 | LWW 依赖客户端时钟 | 记入取舍；必要时升级成字段级 `readAt`/`starredAt` 合并 |
| 10 | 共享引入"别人可读"的库 | 复用 feed/bot 库的 `_security` 模式；只读放行 `user` 角色 |

## 11. 仍未定（实现时敲定，不阻塞开工）

| # | 问题 | 倾向 |
| --- | --- | --- |
| 1 | **`N` 的取值（实测后必须重定）** | 实测（§13.D）：30 天窗口下按抽样均值外推，625 个源的账号 ≈ 47,000 条 / **约 1.46GB 附件**，且重尾（单源 30 天最高 385MB）。**建议默认 `N` ≤ 7 天**（仓库现状是 3 天），30 天只作为 per-feed 覆盖；或附件不进客户端、按需 HTTP 拉 |
| 1b | `δ1` / `G` | 默认 1 天 / 7 天，可配；`G` 按实测最长离线时长调 |
| 2 | 投影的字段集与保留策略（bot / channel 是否同 `N`） | 按"离线阅读够用"定字段；Bot 对外内容可能不裁或大 `N` |
| 3 | 墓碑清除用宽限期还是加 ack 通道 | 先宽限期；有体积或一致性诉求时再上 ack（§5.6） |
| 4 | outbox（PG）与投影的一致性对账口径 | 同一条产出在两边字段集合一致，顺序按 `published_at` |
| 5 | `bot_feed` 与 `channel` 是否合并成同一个库种类 | 暂不合并（同构，随时可合） |

## 12. 怎么验证

- 单测：窗口边界（`publishedAt == bound`、并列时间戳）、`sourceNeedsSync` 新真值表
  （"只有新增才判脏源"）、LWW 裁决（冲突收敛后 `_conflicts` 为 0）、
  `pending_purge` 的到点判定（`deleted_at + G` 边界）。
- 端到端（扩 `packages/nuxt-client/scripts/verify-timeline-sync.mjs`）：
  源库 purge → 汇聚库过期删除 → 客户端跟随缩水；
  **失序时断言会复活**（故意让汇聚库先清，确认源库会把它搬回来 —— 用这条钉子把 §5.4 钉住）；
  墓碑满 `G` 后被 purge 且 `_compact` 后磁盘回落；
  稳态下 `queued: 0`；换 `N` 不触发重扫（checkpoint 复用）；
  **分享链路**：两个用户订阅同一 channel，复制次数 = `M + K`，两人看到同一份内容、各自状态互不影响。
- Bot/内容包投影：删掉投影库内容后能从 PG **幂等重放**；outbox（读 PG）与投影的同一条内容字段一致；
  PG 与投影条数对账为 0 差异。
- 探针：**四个都已跑完，结论见 §13**（脚本与原始输出在 `report/aggregation-purge/`，该目录不进版本控制）。
- 仍未覆盖、需要在真浏览器里量的一项：
  **IndexedDB 的体积与 `compact()` 之后的回收** —— 用 `navigator.storage.estimate()` 在
  compact 前后各取一次（Node/leveldb 下 `du` 不反映回收，见 §13.C）。


## 13. 探针实测结论（本轮）

脚本与原始输出在 `report/aggregation-purge/`（该目录 `.gitignore` 忽略，不进版本控制）。
四个探针全程只用临时库（`probe_*`），未触碰任何现有库。

### A. `_purge` 可以直接清除活文档 —— `probe-a-output.txt`（15/15 通过）

- ✅ 官方那句 "Documents can be previously deleted, but it is not necessary. Revisions must be leaf
  revisions." 成立：拿 `_all_docs` 里的叶子 rev 直接 `_purge` 活文档 → **201**，
  文档同时从 `_all_docs` 与 `_changes` 消失。**"先 delete 再扫 `_changes` 找墓碑"两步可以省掉。**
- `_changes` 里**不会**留下"取不到 rev"的行 → 复制器不会去取不存在的 rev（这是 B 能成立的前提）。
- 每次 `_purge` 会让 `update_seq` 与 `purge_seq` 各 +1，`doc_count` 减少。
- 非叶子 rev / 重复 rev / 根本不存在的 rev → 一律 **201 且 `purged` 为空，不报错**
  → 墓碑账本（`pending_purge`）可以容错重试，不必区分"成功/已被清"。
- **冲突文档必须把所有叶子一起 purge**：只 purge winner 时 loser 分支顶上、文档仍然存在
  （GET 仍 200，rev 变成 loser）；把所有叶子一起 purge 才彻底消失。
- 带附件的活文档 purge 后 `sizes.external` 立刻 204,879 → 22 字节；`_compact` 后文件 283KB → 33KB
  —— 200KB 附件真的回收了。

### B / B2. purge 与按需复制并存 —— `probe-b-output.txt`（22/22）、`probe-b2-output.txt`（6/6）

- ✅ **源库 purge 不会让 checkpoint 失效**：purge 之后同参数复制仍成功、仍从上次序号续读。
  判别法 = 在目标端 purge 一条（源端仍有）再看它会不会被搬回来；**阴性对照**（删掉两端
  `_local/<哈希>` 后同一条确实会被搬回来）证明判别法有效。→ "每天 purge"不会退化成"每天全量重扫"。
- ✅ 目标端**保留**已被源库 purge 的文档（"各端各清各的"成立）；强制全量重扫既不会删掉它、也不会复活它。
- ✅ checkpoint **之后**（尚未复制）的文档被 purge：复制不报错，该文档不会出现在目标端。
- ✅ 全新目标端首拉不含任何已被源库 purge 的文档。
- ✅ **真并发**（600 条 × 50KB 附件，复制途中 purge 掉 300 条）：复制返回 200 / `ok:true`，无 5xx，
  之后再次复制即可收敛（目标端不缺、也不多）。
- ⚠️ **`_replicate` 响应里 `history[0].docs_read` / `docs_written` 不能当"本轮搬了多少"的证据**：
  无改动时会报 200~300，删掉 checkpoint 真重扫时反而报 0~3。
  `workers/timeline-sync.ts:95` 的日志直接打了 `docsWritten`，排查时会误导 —— 建议改打目标端条数
  或直接去掉。（逻辑上没有用这两个数，只用于日志，所以是诊断质量问题、不是正确性问题。）

### C. 客户端本地库：compact 安全，purge 在 Node 下不可用 —— `probe-c-output.txt`（4/4）

- ✅ `db.compact()` **不动修订记忆**：删 20 条 → compact → 擦掉两端 checkpoint 强制重扫 →
  被删的 20 条**一条都没回来**。
- ⚠️ **leveldb 适配器未实现 `purge`**：实测直接抛
  `Purge is not implemented in the leveldb adapter.`
  → Node 侧的 PouchDB（单测、`verify-*.mjs` harness）**不能**用 `db.purge()`；
  只有浏览器 IndexedDB 适配器自 8.0 起支持。
- ⚠️ leveldb 的目录体积在 compact 后**不下降**（2048 → 2060 → 2072KB）：空间留在文件里复用、
  不还给 OS。所以"本地体积会不会涨"不能用 `du` 判断；浏览器侧要用
  `navigator.storage.estimate()` 量（未做，见 §12）。
- "purge 会导致重扫复活"这条在本环境**未能实测**（适配器不支持）。方案里"客户端不 purge"的依据是
  PouchDB 官方对 `purge` 的定位（admin 用途、不是常规删除手段）+ 机制推理，
  加上本条已证明的反面：compact 是安全的。

### D. `N = 30 天` 的真实体积 —— `probe-d-output.txt`（对现有 dev 数据**只读**采样）

- 现有 dev 数据：**713 个源库 / 182,030 文档 / 4.96GB 磁盘**（这是**全量历史**，不是窗口内的量）。
- 30 天窗口内、等距抽样（n=39）：每源 mean **75 条 / 附件 2.34MB**；median 6 条 / 0.16MB；
  p90 108 条 / 2.45MB；max 1468 条 / 61MB。
- 10 个最大源库：窗口内均撞到查询上限 **3000 条**（实际更多），单源窗口内附件最高 **385MB**。
- 外推（按等距抽样均值）：50 个源 ≈ 3,769 条 / 117MB；200 个源 ≈ 15,077 条 / 467MB；
  **625 个源 ≈ 47,115 条 / 约 1.46GB 附件**。分布重尾，实际可能更高。
- **结论：`N = 30` 天不能作默认值。** 中位数远小于均值 —— 账号里只要有几个图片重的源，
  首拉就会从几十 MB 跳到 GB 级。→ 见 §11.1。
