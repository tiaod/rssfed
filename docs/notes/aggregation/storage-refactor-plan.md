# 存储层重构方案：按需复制 + 时间窗口清理 + 状态库独立

> **状态：提案，待确认。未落地。**
> 本文是重构设计稿，**不是现行规范**。落地后只有不变量并入 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)，
> 实现细节留在代码注释里。
> 前置实测结论：[`couchdb-replicator-aggregation.md`](couchdb-replicator-aggregation.md)（复制语义 5 条边界）、
> [`on-demand-replication.md`](on-demand-replication.md)（常驻复制被打崩 → 按需 + 水位）、
> [`sync-window-anchor.md`](../sync/sync-window-anchor.md)（复制 id 与窗口锚点）。
> **本次是重构：不做历史数据迁移，服务端与客户端旧数据一律清空。**

> **已定**：复制按需触发；**源库不清（永久存档）、删除不进复制**；订阅意图与已读收藏放独立状态库；
> 冲突保留最新修改；共享载体是独立 `channel:{id}`；Bot 投影库是 `bot_feed:{id}`；
> **汇聚库 delete 留墓碑、墓碑不清**（重扫不复活）；**客户端自己按 bound 清一遍**；
> Bot 完整数据改放 PostgreSQL（标准 BotKit）。
>
> **本轮已完成（加法式，未接进 worker 运行路径）**：§13 的五个探针已跑完并留档；
> `packages/hono-server/src/couchdb/retention.ts` + 19 个单测已落地（窗口下界、按窗口 delete、
> 容错的批量 purge）；探针脚本在 `packages/hono-server/scripts/probes/`。

## 0. 一句话

**源库不清**（原始存档），**汇聚库留 14 天**（客户端看到的量）—— 汇聚库用 delete 留墓碑，
既让删除顺带到客户端、又挡住"重扫时从完整源库搬回来"；**客户端再按服务端下发的 bound 自己清一遍**；
复制只负责"把源库的新文档增量搬下去"（**静态 selector，无时间谓词，删除不参与**）；
用户意图（订阅、已读、收藏）放独立状态库，永不清理；
**内容包的完整数据在 PostgreSQL，CouchDB 只承载可重算的离线阅读投影。**

## 1. 要的 / 付出的

**要的**：两端都有界；没有常驻复制任务；没有 per-user 窗口、没有剪枝扫描、
没有"放大窗口要回填"这套机制；删除语义**完全不用设计**（删除不进复制）；
**客户端只镜像、不做任何清理判断**（浏览器时钟与本地调度不再参与过期认定）。

**付出的**（记账，写在明处）：

1. **汇聚库不能 purge，只能 delete 留墓碑**：purge 抹掉修订记忆，全量重扫时会被完整源库搬回来
   （实测 §13.E）。代价是墓碑线性增长（§5.6，只监控）。
2. **用户驱动的删除要各端自己执行**（退订/删源），不能靠复制传播（§5.5）。
3. LWW 依赖客户端时钟（§8）。
4. 客户端第一次拉取的量 = 汇聚库窗口（`N_agg = 14 天`）内的全部内容（含附件），`N_agg` 直接决定它（§10 风险 4）。
5. **Bot/内容包是"PG 权威 + CouchDB 投影"双存储**：投影必须可幂等重算，否则会出现
   "PG 有、离线看不到"且没人发现（§7）。
6. **客户端本地只增不减**（不 purge、不重置）：过期内容与墓碑会留下，必须靠 `compact()` 回收附件与旧修订（§6）。

## 2. 新不变量

1. **窗口只有一个来源**：服务端计算 `retention_bound = 服务端时刻 − N 天`，落库并随同步下发。
   客户端不得用本机时钟现算 `now − N`（`sync-window-anchor.md` 实测：跟着时钟走的 selector
   会让复制 id 每天变一次）。**客户端根本不参与过期认定**，只用服务端下发的 bound（如果需要）。
2. **源库不清、汇聚库留 14 天**：源库是原始内容存档，不参与保留策略；`N_agg = 14 天` 才是
   客户端能看到的历史量。**汇聚库用 delete 留墓碑、墓碑不清**（墓碑是"重扫不复活"的唯一保证，
   实测 §13.E）。全量重扫不会复活已删内容，只有"重建到空库"会整份搬一遍 → §5.4。
3. **复制只搬新增**：静态 selector `{"type":"entry"}`（仓库实际的文档类型是 `entry` / `feed`，时间字段是 `publishedAt`），无时间谓词、无 `query_params`
   → 复制 id 永久稳定、checkpoint 永久复用。删除标记不参与复制。
4. **服务端做主体清理**（汇聚库按 `N_agg` delete + compact），**客户端再自己清一遍**
   （用服务端下发的 bound，delete + compact，不用 purge）；两边都不依赖对方单独正确。
5. **用户意图驱动的删除各端自己执行**：服务端删汇聚库副本 + 删水位行，客户端删本地。
6. **一用户两库**：汇聚库（内容副本 + 源清单，服务端写、客户端只读）与
   状态库（`subscription:` / `entry-state:` / `group-pref:`，客户端写、双向、永不清理）。
7. **状态与文章解耦**：文章被清掉不影响状态文档，不做级联删除。
8. **冲突按"保留最新修改"**：客户端可写文档带 `updatedAt`，冲突时保留最新一版并显式删除输的分支。
9. **没有 per-user 窗口**：`windowDays` / `minFeedEntries` 整套消失；`N_agg` 是服务端配置（源库不清）
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

- **为什么不干脆在 selector 里加"窗口内"过滤？** 两个理由，第二个是硬的：
  1. 窗口过滤是**汇聚库自己的清理职责**（§5.3），把它同时塞进复制层就是第二套权威；
  2. **selector / `query_params` 参与复制 id**。`bound = now − N_agg` 每天都变 → 复制 id 每天变
     → checkpoint 失效 → **每个 (用户×源) 每天从 0 全量重扫**。
     仓库现在的代码就是这么写的（`replicator.ts` 的 `query_params.minPublishedAt`，注释里
     已经写着"新的 boundIso = 新哈希 = 重扫"），这正是这次重构要消掉的那笔开销。
     代价形状：重扫不重传文档体（目标端 `_revs_diff` 会发现都有了），只走 `_changes` 元数据，
     单源不贵；但它是**全量而不是增量**：实测单源 1240 条 = 63 请求 / 306KB，625 个源的账号
     每天就是多走十几万行元数据，而且得摊开跑 —— 和当年压死 2 核机的形状是同一个。
     所以过滤不放在复制路径上：**复制只搬新增，过期的由汇聚库自己清**。
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

## 5. 保留与清理

### 5.1 三个决定

| 谁 | 保留 | 清理动作 |
| --- | --- | --- |
| 源库 / 投影库 | **不清**（永久存档） | 无 |
| 汇聚库 | `N_agg = 14 天` | **delete 留墓碑，墓碑不清** |
| 客户端 | 由服务端下发的 bound 决定 | **自己清**（delete + compact，不用 purge） |

- **源库不清**：源库是原始内容的存档，不参与保留策略 —— 直接省掉一整层清理。
- **汇聚库 delete 而不 purge**：墓碑是"重扫安全"的唯一保证。✅ 实测（§13.E）：
  目标端 purge 掉 100 条后，同参数**增量**复制不会把它们搬回来（checkpoint 也不受影响），
  但**删掉 checkpoint 做全量重扫时 100 条全部复活**（源库是完整存档 + purge 抹掉了修订记忆）；
  换成 delete 留墓碑后重扫 **0 条复活**（墓碑挡住重发）。
- **墓碑不清**：墓碑约百字节/条（附件已被 compact 回收），留着比清掉更省事 ——
  清掉就丢了"重扫安全"，为了不丢它又要引入宽限期 `G`、墓碑账本、甚至客户端 ack 那一整套。
  代价只是**线性增长**（§5.6 有量级）。
- **客户端删不删的争论因此不需要了**：墓碑在，删除就**顺带**被复制到客户端；
  客户端同时再按下发 bound 自己清一遍 —— 双保险，不依赖任何一方单独正确。
- `retention_bound = now − N_agg`，**服务端算一次**并随同步下发给客户端；客户端不得用本机时钟现算。

### 5.2 `_purge` 的正确姿势（源库已不清，留给手工维护/以后真要清时用）

- **可以直接 purge 活文档**，不必先删除：官方 `_purge` 文档原文 "Documents can be previously
  deleted, but it is not necessary. Revisions must be leaf revisions." → 从 `_all_docs` 拿
  `{_id, _rev}` 直接 `_purge`，**省掉"先标准删除"和"扫 `_changes` 找墓碑"两步**。
  ✅ 实测（§13.A）：201、文档从 `_all_docs` 与 `_changes` 同时消失、`_changes` 不留取不到 rev 的行。
- **冲突分支要一起 purge**：只 purge winner 时 loser 顶上、文档还在。✅ 实测。
  用 `_all_docs?conflicts=true&include_docs=true` 一起带上。
- 要 admin 权限；批量 ~1000 条/次；**purge 之后必须 `_compact`** 才回收磁盘
  （✅ 实测：200KB 附件，file 283KB → 33KB）。
- 非叶子/重复/不存在的 rev 一律 201 且 `purged` 为空，**不报错**（可以容错重试）—— ✅ 实测。

### 5.3 汇聚库的清理：delete，不 purge

- 扫描 `publishedAt < bound` 的条目（视图或 `_find`）→ 批量 `_bulk_docs` 写 `_deleted: true`。
- 只删 winner：聚合条目的冲突极罕见（复制用 `new_edits:false` 写入），真出现了交给 LWW 裁决（§8）。
- **不要 purge**（理由见 §5.1 / §13.E）。删除后附件字节靠 `_compact` 回收。
- 每轮记 `docs_deleted`；稳态下每天删掉的量 ≈ 每天新增量。

### 5.4 唯一会把内容"搬回来"的场景：全量重扫 / 重建

- **日常增量复制不会复活任何东西**（✅ 实测 §13.E）：checkpoint 稳定、旧序号不会被重读。
- 全量重扫（checkpoint 丢失、`?force=1`）：
  - 汇聚库用 delete 留墓碑 → 已删的**不复活**，只是重扫一遍元数据（便宜）；
  - 若当初用的是 purge → 全部复活（所以要 delete）。
- **重建到空库**是另一回事：静态 selector 会把**源库整份存档**搬一遍再裁到 14 天。
  dev 数据是 713 个源 / 182,030 文档 / 4.96GB，所以重建很贵。
  → **重建路径用一次性带窗口的 selector 预筛**：重建本来就要重扫，复制 id 变了也无所谓，
  这样只搬窗口内的内容。这条只影响重建路径，不影响日常复制。
- 客户端**不要用 purge**：PouchDB 官方把 purge 定位成 admin 用途（抹修订记忆），
  Node/leveldb 适配器根本没实现（✅ 实测 §13.C）。客户端要 `delete` + `compact()`。

### 5.5 用户驱动的删除（退订 / 删源）

服务端：删汇聚库副本 + 删水位行；客户端：本地删该源的条目（它自己就有订阅意图）。
两边各自执行。**这是"删除不进复制"必须补的上半场**，否则退订后内容要挂到自然过期。

### 5.6 墓碑的增长量级（唯一要盯的指标）

- 每天新增墓碑 ≈ 当天过期掉的条目数 ≈ 每天新增量。
- 估算：625 源的重账号约 1.6k 条/天（30 天 47k 条），一年约 57 万条；
  每条约 100–400 字节（附件已被 compact 回收），即 **每年 60–230MB/账号**，随账号数线性叠加。
- 监控 `doc_del_count` 与文件体积。真不能忍时再加"墓碑超过 X 个月就 purge"：
  代价是之后的一次重扫会把那批老文档复活一次（再被删掉），属于可接受抖动。
- **不换代**：现有"重建/换库"作为手动排障能力保留，但不属于保留策略。

## 6. 客户端

- 本地库名换新（`rssfed-articles-<userId>` / `rssfed-state-<userId>`），启动清旧库
  （复用现有 `cleanupLegacyDbs`）—— 对应"直接清库、不迁移"。
- 通道一：`replicate.from(汇聚库, { live:true, retry:true })`，**不带 selector**。
  这样汇聚库的删除（过期删除 + 退订删除）会**自动到端**，客户端即时缩水；
  也少一个会随窗口漂移的复制参数。
- 通道二：`sync(状态库, { live:true, retry:true })`，双向。
- **自己清一遍**（§2.4）：拿服务端下发的 `retentionBound`，把本地 `publishedAt < bound` 的条目
  **delete**（不用 purge）+ `compact()`。细节：
  - 只用服务端下发的 bound，**不用本机时钟** → 设备时钟快慢不会导致多删/漏删；
  - 本地窗口比服务端**小一天**（`bound_client = retentionBound + 1 天`），
    避免"刚清掉又被复制搬回来"的抖动；
  - 墓碑本来就会顺带到端，所以即使这段清理没跑也不影响正确性（双保险）。
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

**新增**：`couchdb/retention.ts`（窗口下界 + 汇聚库按窗口 delete + 容错批量 purge，手工维护用）、
状态库建库/设计文档/闸门、客户端按 bound 自清、
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
`channels`；`feeds.last_new_entry_at` 保留（不再需要 `last_changed_at`）。

**前端**：profile 页窗口/保底条数档位删掉；本地库名换新 + 清旧库；订阅读写改到状态库；
退订时本地自己删该源条目。

## 10. 风险

| # | 风险 | 处理 |
| --- | --- | --- |
| 1 | **源库/汇聚库清理失序 → 复活循环**（静默、每轮重复） | §5.4 写成不变量 + 回归用例（故意让汇聚库先清，断言会复活 → 把机制钉住） |
| 2 | 首轮导入 / 上线重扫的复制爆发（当年压垮 2 核机的场景换马甲） | 单飞 + 队列并发上限 + 首轮排队；监控 `queued` |
| 3 | selector 依赖"每个文档都带 `type`"这个脆性前提，不带就被静默丢弃 | 写进源库设计文档注释 + 断言新文档类型必须带 `type` |
| 4 | 几百个源 × `N_agg = 14 天` 的**首次拉取量**（含附件）仍是 GB 量级（实测 §13.D：每源 30 天 mean 2.34MB、重尾单源 385MB） | 已量化；客户端分段/按需拉取；重账号首拉时长列入监控 |
| 5 | **客户端本地只增不减**（不 purge/不重置） | 必须 `compact()`（回收附件与旧修订）；监控 IndexedDB 体积；墓碑行本身很小（~百字节/条） |
| 6 | 墓碑在客户端离线超过 `G` 时被清 → 该设备永久保留一份过期内容 | `G` ≥ 最长离线时长；监控"错过删除的设备数" |
| 7 | **Bot/内容包双存储不一致**：PG 写了、投影没写 → 离线看不到且无人发现 | 投影由 worker 从 PG 幂等派生 + 重试 + 可重放；加"PG 与投影条数对账"监控 |
| 8 | outbox 改从 PG 读：分页/排序/去重语义与原来 CouchDB 视图不一致 | 建 `(bot_id, published_at)` 索引；对账 outbox 与投影的同一条内容字段一致 |
| 9 | LWW 依赖客户端时钟 | 记入取舍；必要时升级成字段级 `readAt`/`starredAt` 合并 |
| 10 | 共享引入"别人可读"的库 | 复用 feed/bot 库的 `_security` 模式；只读放行 `user` 角色 |

## 11. 仍未定（实现时敲定，不阻塞开工）

| # | 问题 | 倾向 |
| --- | --- | --- |
| 1 | ~~`N` 的取值~~ **已定** | **源库不清、`N_agg = 14 天`**。`N_agg` 决定客户端首拉：实测（§13.D）每源 30 天窗口 mean 2.34MB 附件、重尾（单源最高 385MB），14 天约打对折；重账号的首拉时长列为监控项，不阻塞开工 |
| 1b | ~~墓碑清理~~ **已定** | **墓碑不清**（§5.1/§13.E）。代价是线性增长（§5.6 量级），只监控不清理；真要清时再加"X 个月后 purge"，那是单独一条策略 |
| 2 | 投影的字段集与保留策略（bot / channel 是否同 `N`） | 按"离线阅读够用"定字段；Bot 对外内容可能不裁或大 `N` |
| 3 | 客户端自己清的窗口比服务端小多少 | 先取 1 天余量；观察是否出现"刚清又被搬回来"的抖动 |
| 4 | outbox（PG）与投影的一致性对账口径 | 同一条产出在两边字段集合一致，顺序按 `published_at` |
| 5 | `bot_feed` 与 `channel` 是否合并成同一个库种类 | 暂不合并（同构，随时可合） |

## 12. 怎么验证

- 单测：窗口边界（`publishedAt == bound`、并列时间戳）、`sourceNeedsSync` 新真值表
  （"只有新增才判脏源"）、LWW 裁决（冲突收敛后 `_conflicts` 为 0）、
  客户端按 bound 自清的边界（`publishedAt == bound`、与服务端窗口差一天）。
- 端到端（扩 `packages/nuxt-client/scripts/verify-timeline-sync.mjs`）：
  汇聚库过期 delete → 客户端跟随缩水；客户端按 bound 自清；
  **重扫时断言不复活**（用 delete 留墓碑，确认 §13.E 的性质在真实链路里成立）；
  客户端自清之后本地不再留窗口外条目；
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
  → 调用方可以容错重试，不必区分"成功/已被清"。
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

### E. 目标端 purge 会不会被完整源库重新搬回来 —— `probe-e-output.txt`（7/7）

用户提出的问题：源库永久保留，汇聚库 purge 掉旧文档，下一次同步会不会把它们搬回来？

| 汇聚库怎么清 | 日常增量复制 | 全量重扫 / 重建 |
| --- | --- | --- |
| **purge 活文档** | 不复活 ✓（100 条一条没回来，checkpoint 也没坏） | **100 条全部复活** |
| **delete 留墓碑** | 不复活 ✓ | **0 条复活**（墓碑挡住重发） |

- 日常不复活的原因是**增量**：被 purge 的文档序号在 checkpoint 之前，复制器不会重读。
  目标端 purge 也不会让复制器丢 checkpoint（实测：purge 后 `_local` 仍在、下次仍是增量）。
- 重扫会复活的原因是：源库是完整存档，而 purge **抹掉了修订记忆** → 目标端 `_revs_diff`
  认为这些 rev 它没有 → 全部重传（含附件）。
- **所以汇聚库必须用 delete 留墓碑**，这也是本方案"墓碑不清"的直接依据（§5.1）。
- 附带量化：300 条 × 5KB 的样本上，重扫复活多搬 0.49MB 附件；按真实体量放大即可估重建代价。
