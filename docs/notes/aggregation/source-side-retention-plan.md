# 源侧保留：把「保留区间」从每用户过滤改成源库物理裁剪

> **状态：提案，待确认。本文是存储层重构的收敛方案（2026-10 收敛：保留策略以本文为准）。**
> 落地后只有不变量并入 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)，实现细节留在代码注释里。
> 前置实测结论见 [`couchdb-replicator-aggregation.md`](couchdb-replicator-aggregation.md)
> 与 [`on-demand-replication.md`](on-demand-replication.md)；本文 §9 是本轮新增探针的结论
> （`probe-f` 验证了本方案的机制基石，`probe-e` 说明为什么裁剪必须用 delete）。
> 原 `storage-refactor-plan.md` 里与保留无关的决定已并入 §10，那份文档已删除。

## 0. 一句话

把保留策略从「**复制时**按每用户窗口过滤 + 用户库**再挑一遍**」改成
「**源库自己**只保留每条源最新 N 条，用户库是源库的**精确镜像**」。

## 1. 要解决的问题

| 现状问题 | 出处 |
| --- | --- |
| 每用户每 5 分钟 **O(用户库全部条目)** 的剪枝扫描 —— 整个聚合链路里唯一随数据量恶化的成本 | `pruneBelowPerFeedFloor`（`services/timeline.ts:490-532`）；默认 `minFeedEntries=50` 时必走这条 |
| 复制参数含可变下界 → 换窗口 = 换哈希 = **从 0 重扫源库** | `couchdb/replicator.ts:76-92` |
| 保留规则「窗口 ∨ 每源最新 N 条」有**两套权威**（过滤器下界 + 服务端剪枝），边界容易错 | `restoreTombstonedEntries`（`timeline.ts:568`）就是为此打的补丁 |
| feed 库只写不删、**无限增长** | `workers/index.ts:152-158`（已存在则 `continue`，从不删） |
| 用户库里的内容与源库的关系是"近似投影"，要额外维护 | 同上 |

## 2. 新不变量

1. **源库只保留每条源最新 N 条**，由抓取 worker 在每次抓取后裁剪（物理删除）。N 是全局常量，不再 per-user。
2. **用户库是源库的精确镜像**：复制**不带任何参数**（`query_params` 消失），filter 只挡设计文档。
   **删除通过复制自然传播** —— 这是本方案的机制基石。
3. **用户库不再剪枝**。保留策略的唯一权威是源库的裁剪。
4. N 用**条数**而不是天数：一次同时解决「源库有界」（新需求）与「低频源兜底」
   （`minFeedEntries` 原本要解决的问题，`timeline.ts:69-72`）。

## 3. 数据流

### 3.1 现在

```
                     ┌───────────────────────────────────────────────┐
抓取 worker ──写入──▶│ feed 库   entry:feedX:*  （只增不删，无限增长）│
（无裁剪）           │           feed:feedX、_design/main            │
                     └───────────────────────────────────────────────┘
                                     │ feeds.lastNewEntryAt = now（仅"抓到新条目"时）
                                     ▼
reconcile（每用户，TIMELINE_INTERVAL = 300s）
   ① 读订阅  ② 判脏源  ③ readSourceFloor → boundIso
   ④ pruneOutsideRetention：扫用户库全部条目（每页 500）   ◀── 瓶颈
   ⑤ 脏源入队 rss-timeline-sync
                                     ▼
sync worker ──POST /_replicate──▶ 用户库
              filter   = main/timeline        entry:* feed:*（只增不减）
              query_params.minPublishedAt            │
                                                     ▼ CouchDB live replication
                                              浏览器 PouchDB
```

### 3.2 改成

```
抓取 worker
   ① 写新条目 ────────▶ feed 库  entry:feedX:*
   ② 裁剪【新】 ──────▶ 保留最新 N 条，删其余（含图片附件）
   ③ feeds.last_changed_at = now【新列：有写入或有删除都要写】
                                     │
                                     ▼
reconcile（每用户，节奏不变）
   ① 读订阅  ② 判脏源（last_changed_at > synced_at）
   ③ 脏源入队                          ◀── 没有剪枝了
                                     ▼
sync worker ──POST /_replicate──▶ 用户库
              filter = main/timeline          entry:* feed:*（增 + 删，精确镜像）
              无 query_params                        │
                                                     ▼ CouchDB live replication
                                              浏览器 PouchDB
```

### 3.3 五个场景的逐步流向

#### A. 抓取到新条目（同时挤掉一条老的）

1. worker 写 `entry:feedX:new`（multipart，图片附件与条目一次写入）
2. worker 裁剪：`view("main","entries-by-date", { descending: true, limit: N + 1 })`
   - 行数 ≤ N → 无需删，跳到 3
   - 第 N+1 行的 key 即 `bound` → 删除 `publishedAt < bound` 的条目（分页游标，
     写法可参考现有 `pruneBelowPerFeedFloor`，`timeline.ts:490-532`）
3. worker 写 `feeds.last_changed_at = now`
4. reconcile：`last_changed_at > timeline_source_sync.synced_at` → 脏源 → 入 `rss-timeline-sync`
5. sync worker：`POST /_replicate`（只有 `filter`，**无 `query_params`**）
   - checkpoint 命中 → 从上次序号续读 `_changes`
   - **新增与删除在同一次复制里一起送达**
6. 用户库产生 `_changes` → 浏览器 live replication → 前端增/删

#### B. 条目滑出保留窗口（源库只删、没有新条目）◀── 关键修复点

1. worker 裁剪，删掉 m 条
2. worker 写 `feeds.last_changed_at = now`
   **必须写**：`lastNewEntryAt` 只在"抓到新条目"时更新（`workers/index.ts:48,51`），
   否则这次删除不会被判成脏源 → **不触发复制 → 删除永远不传播**，
   表现为"源库删干净了，用户库里全留着"。
3. 之后同 A 的 4–6：删除作为 `_deleted` 变更复制到用户库，再 live replication 到浏览器

#### C. 新订阅

1. 客户端写 `subscription:feedX` 到用户库
2. reconcile：水位表没有该源的行 → 脏源（`sourceNeedsSync`）
3. 复制没有 checkpoint → 从 seq 0 读 `_changes`，把源库**当前**内容（= 最新 N 条）全搬过去
4. **这次全扫是最后一次**：没有 `query_params`，参数不会变，checkpoint 永久复用

#### D. 退订（不变）

`deleteByPrefix(entryIdPrefix(sourceId))` + 删 FeedDoc + 删水位行

#### E. 重建 / 换库（不变）

换空库 + 搬用户自己写的文档 + 水位作废（`isDerivedDbFresh`）→ 全源重扫

## 4. 改动清单

### 4.1 新增

| 位置 | 内容 |
| --- | --- |
| `src/couchdb/retention.ts`（新文件） | `trimSourceToLatestN(scope, n)`：视图倒序取 N+1 行算 bound → 分页删 |
| `workers/index.ts` 抓取路径 | 写完成后调用裁剪；bot 路径同理（`workers/index.ts:293` 附近） |
| `feeds` / `bots` 表 | 新列 `last_changed_at` |
| 常量 / 环境变量 | `SOURCE_RETENTION_ENTRIES`（建议默认 **50**，即现在 `minFeedEntries` 的默认值） |

### 4.2 修改

| 位置 | 改动 |
| --- | --- |
| `couchdb/client.ts:64-71` | `TIMELINE_REPLICATION_FILTER` 简化（见 4.3）；删 `TIMELINE_REPLICATION_FILTER_QUERY_PARAM`（`client.ts:62`） |
| `couchdb/replicator.ts:88-92`、`125-147` | 删 `replicationQueryParams`；`runSourceReplication` 去掉 `boundIso` 参数与 `query_params` |
| `services/timeline.ts:746-757` | `sourceNeedsSync` 删掉 window/minEntries 判据，改比 `last_changed_at` |
| `services/timeline.ts:1027` | reconcile 第 ④ 步剪枝整个删掉 |
| `routes/timeline.ts` | 设置接口去掉 window/floor 字段（`PATCH /api/timeline/settings`） |
| `packages/nuxt-client` profile 页 | 删窗口 / 保底条数档位 |
| `db/schema.ts` | 见 4.4 |

### 4.3 新 filter

```js
function(doc) {
  // 源库的设计文档不能搬进用户库：用户库自己也有 _design/main
  //（写方向闸门 validate_doc_update + 视图），两份撞上会变成冲突分支，
  // CouchDB 的赢家不确定 —— 最坏情况是把写方向闸门顶掉。
  return doc._id.indexOf('_design/') !== 0;
}
```

**关键点：没有 `query_params`** → replication id 只由「源库 + 目标库 + filter 源码」决定
→ **filter 源码不变则 checkpoint 永久复用**。这消掉了
「换窗口 = 换哈希 = 从 0 重扫源库」这个最贵的性质（`couchdb-replicator-aggregation.md` 结论 3）。

> **filter 不能省。** feed/bot 库的 `_design/main` 里有 `entries-by-date` 视图，
> **bot outbox API 在用**（`routes/bots.ts:181`，ActivityPub 对外的内容源），删不掉；
> 而"无过滤器全量复制"会把它搬进用户库撞车。所以 filter 保留，但它的职责从
> 「窗口过滤」**降级为**「挡住设计文档」——这是完全不同的一件事。

### 4.4 删除与迁移

**整块删掉：**

| 对象 | 位置 |
| --- | --- |
| `windowStartIso` / `looserBoundIso` / `retentionBoundIso` / `readSourceFloor` / `SourceFloor` | `timeline.ts:176-244` |
| `pruneOutsideRetention` / `pruneOlderThan` / `pruneBelowPerFeedFloor` / `deleteDocsByIds` | `timeline.ts:450-545` |
| `restoreTombstonedEntries` | `timeline.ts:568` |
| `normalizeBoundIso`、水位读取里的 bound 归一 | `timeline.ts:676` |
| `replicationQueryParams` | `replicator.ts:88` |
| `TIMELINE_REPLICATION_FILTER_QUERY_PARAM` | `client.ts:62` |
| 用户库设计文档的 `timeline-maintain` 两条视图 | `client.ts`（**`validate_doc_update` 必须保留** —— 写方向闸门） |

**schema 迁移：**

| 表.列 | 处理 |
| --- | --- |
| `user_timeline_settings.window_days`（`schema.ts:110`） | 删除 |
| `user_timeline_settings.min_feed_entries`（`schema.ts:119`） | 删除 |
| `timeline_source_sync.window_days`（`:175`）/ `min_entries`（`:177`）/ `bound_iso`（`:184`） | 删除 |
| `feeds.last_changed_at` | 新增，回填 = `last_new_entry_at`（`UPDATE feeds SET last_changed_at = last_new_entry_at`）—— **已加** |
| `bots.last_changed_at` | **不加**：bot 库不裁剪（§10.7），仍用 `lastNewEntryAt` |
| `feeds.last_new_entry_at`（`:210`） | **保留** —— 前端"最后更新"仍在读（`services/feeds.ts:285`、`routes/mcp.ts:244`） |

**聚合库不需要迁移**：filter 源码变了 → 每个 (用户 × 源) 的下一次复制自然是新哈希、从 0 重扫；
而重扫会把源库**当前状态（含删除）**精确送达，用户库自动收敛成镜像。

## 5. 风险与上线注意

| # | 风险 | 处理 |
| --- | --- | --- |
| 1 | **首次裁剪的删除风暴**。源库现在存着全部历史（可能几十万条），策略上线时第一次裁剪会删掉绝大多数 → 数百个源同时产生大批删除 → 重演"625 条复制压垮 2 核机"。 | 裁剪**限速 / 分批**（如每次抓取最多删 200 条）；上线期与复制入队错峰；先在单源 / 小账号验证收敛 |
| 2 | **CouchDB 删除不释放磁盘**。删条目只产生 tombstone，附件同理，必须 compaction 才回收。不配的话"砍掉无限增长"只是逻辑上的，磁盘照涨。 | 配 `[compactions]` 或定时 `_compact`；验收标准是**磁盘真的降下来** |
| 3 | **删除的信号**。`lastNewEntryAt` 只在新条目时更新 → 删除不会触发同步。 | 新增 `last_changed_at`，场景 B 里也写（这是全方案最容易漏、且漏了会静默失效的一点） |
| 4 | **bot 库的裁剪会改变对外协议内容**。bot 库是 ActivityPub outbox 的内容源。 | **已定：bot 库不裁剪**，且 bot 数据要挪回 PostgreSQL（标准 BotKit，§10.4）；CouchDB 里只留离线阅读投影 |
| 5 | **浏览器 tombstone 累积**。删除从源库出发、经用户库复制到每个浏览器；PouchDB 不 purge tombstone。 | 量级与现在的剪枝删除相当，但来源变成"一次删除 × N 订阅者"。上线后观察本地库体积 |
| 6 | **`publishedAt` 乱序**。"刚抓到但发布时间很老"的条目会被立刻裁掉。 | 与现在的窗口过滤行为一致（现在的下界也按 `publishedAt` 判），不是回归；但要写进代码注释 |
| 7 | **同一 `publishedAt` 并列**。按 bound 做范围删除可能多留/少留并列条目。 | 保留策略满足"**至少** N 条"即可，允许小幅超出；实现里按 id 去重避免重复删 |
| 8 | **裁剪与复制并发**。 | 删除幂等（同 rev 删两次，第二次 conflict，忽略）；水位沿用"记复制**开始**时刻"的纪律（`schema.ts:152-155`），宁可多搬一轮 |

## 6. 待拍板

1. ~~**放弃 selector 吗？**~~ **已定：放弃，用 filter function。** 实测见 §9.1：
   Mango selector 匹配不到墓碑（删除会静默丢失），而 filter function 能带走删除。
2. ~~**N 取多少？**~~ **已定：N = 50**（= 现 `minFeedEntries` 默认），全局一个值。
   bot 库不适用（不裁剪，见 §10.7）。
3. **"想多看历史"怎么回应？** 原来靠 per-user 的 `windowDays` / `minFeedEntries` 调，
   现在只能调全局 N（或按源类型分层）。
4. **上线限速的具体参数**（每次抓取最多删多少条）。
5. **compaction 策略**（自动 vs 定时）。

## 7. 预期收益

- **删掉**：6 组函数 + 3 个 schema 列 + 1 个设置项 + 用户库的 2 条视图；
- **消除**每用户每 5 分钟 O(用户库) 的剪枝扫描 —— 唯一随数据量恶化的成本；
- **消除**换窗口导致的源库全量重扫（`query_params` 消失，checkpoint 永久稳定）；
- feed 库不再无限增长（配合 compaction 磁盘真正回落）。

## 8. 怎么验证

- 单测：裁剪的边界（≤N 不删、恰好 N、并列时间戳）、`sourceNeedsSync` 新真值表、
  "只删不增也判脏源"（场景 B 的回归钉子）。
- 端到端：扩 `packages/nuxt-client/scripts/verify-timeline-sync.mjs` ——
  源库裁剪 → 删除跟随到用户库 → 浏览器跟随删；
  **稳态下 `queued: 0`**（原断言保留）；
  **不再有剪枝扫描**（断言 reconcile 不查用户库视图）；
  换 N 之后 checkpoint 复用（不重扫）。


## 9. 本轮实测补充（2026-10）

原始输出在 `report/aggregation-purge/`（未纳入版本控制），脚本在
`packages/hono-server/scripts/probes/`。

### 9.1 基石已验证：删除跟着 filter 复制传播（`probe-f`，9/9 通过）

复制**只带 filter**（§4.3 那个新 filter）、**无 selector、无 `query_params`**：

- 源库的 `_design/main` 不会搬进用户库 ✔（否则两份设计文档撞车）
- **源库删 30 条 → 同参数再复制 → 用户库那 30 条也消失，而且拿到的是 30 条墓碑** ✔
- 按"最新 N 条"裁剪源库后再复制，用户库**精确收敛成 N 条** ✔
- 全程只有一个 `_local/<哈希>` checkpoint，没随裁剪/删除变化 ✔

所以 §2.2「删除通过复制自然传播」成立。**但必须用 filter function**：早前实测过 Mango `selector`
匹配不到墓碑（`deleted:true` 的变更没有可匹配字段），删除会静默丢失 —— 这就是 §6.1 那个问题的答案。

### 9.2 裁剪必须用标准 delete，不能用 `_purge`（`probe-e`，7/7 通过）

| 源库怎么清 | 日常增量复制 | 全量重扫 |
| --- | --- | --- |
| `_purge` 活文档 | 不复活 | 被删条目**全部搬回来**（源库是唯一来源 + purge 抹掉修订记忆） |
| **标准 delete**（留墓碑） | 不复活 | **0 复活**（墓碑挡住重发） |

§3.2 的裁剪本来就是 delete，这条实测是它的依据；也说明**别为了省空间对源库做 purge**。

### 9.3 其它已测性质（都是本方案的支撑论据）

- **换复制参数 = 从 0 重扫源库**（`probe-b2`）：所以"没有 `query_params`"这条节省的是每轮全量重扫。
- **条数比时间窗口更能压住体积**（`probe-d`）：30 天窗口下按抽样外推，625 个源的账号约 47,000 条 /
  **~1.46GB 附件**，且重尾（单源 30 天最高 3000 条 / 385MB）；而"每条源最多 50 条"直接把这几个重源
  压到 50 条。这是选"条数"而不是"天数"最硬的理由。
- **客户端**：现有 live pull 不带 selector，删除会跟着到浏览器，本地自动缩水；
  PouchDB 的 `purge` 在 Node/leveldb 下根本没实现（`probe-c`），官方定位也是 admin 用途 ——
  客户端只做镜像，不需要自己清。
- **删除不释放磁盘**：delete 只产生墓碑，附件要 `_compact` 才回收（`probe-a`：200KB 附件
  purge+compact 后文件 283KB → 33KB）。§5 风险 2 的处理必须真的配上 compaction。

### 9.4 这方案唯一还没有答案的地方

**源库墓碑会线性增长**：裁剪用 delete，每删一条留一个墓碑（约百字节，附件被 compact 回收）。
量级 ≈ 累计删除量 ≈ 长期累计抓取量，一个 625 源的重账号约 0.6–1.6k 条/天 → **每年约 60–230MB**。

- 这**不是回归**（现在的剪枝也用 delete），但它是"墓碑会长期留着"这件事的源头。
- 先**不清**：墓碑正是"删除能传播"和"重扫不复活"的载体，清早了会静默漏删除
  （用户库永久多留一条）。真要清时加宽限期（墓碑满 X 时间后 purge），代价是之后一次重扫
  可能把那批老条目搬回来一次。
- 监控：源库 `doc_del_count` 与文件体积。

## 10. 其余决定（与保留策略无关，但仍要落地）

保留策略之外的事已经定过，和本文不冲突，落地时一起做：

1. **一用户两库**：`user:{userId}`（内容镜像 + 源清单，服务端写、`validate_doc_update` 只放行 admin）
   与 `state:{userId}`（`subscription:` / `entry-state:` / `group-pref:`，客户端写、双向、永不清理）。
   **保留策略只作用于内容库**；状态与文章解耦，文章被清掉不级联删状态。
2. **订阅意图放状态库**：reconcile 从状态库读订阅，不再依赖内容库里的 `subscription:` 文档。
3. **内容包**：`channel:{id}`（共享）与 `bot_feed:{id}`（Bot 对外产出投影）；完整数据在 PostgreSQL，
   CouchDB 只存可重算的离线投影，被按需复制进用户内容库 —— 与本文的复制机制同构，不需要改。
4. **Bot 产出改放 PostgreSQL**（标准 BotKit 的做法），投影从 PG 幂等派生；`bot_feed:{id}` 只是
   **离线阅读投影**，不受本文的 N=50 裁剪约束（删多少由 PG 侧的投影策略决定）。
   ⚠️ 会反转 `ARCHITECTURE.md` 现行的一条不变量（"Bot 的产出也不在 PostgreSQL"），落地时一起改。
5. **冲突按"保留最新修改"**：客户端可写文档带 `updatedAt`，读到 `_conflicts` 时保留最新并把输的分支
   显式删掉；不用 `validate_doc_update` 拒过期写（慢钟设备会被永久拒写）。
6. **不做历史数据迁移**：服务端与客户端旧库一律清空重建（客户端换新库名 + 启动清旧库，
   同时把 `feeds.couch_db_name` / `user.timeline_db_name` 置空，否则下一次 ensure 会去找已删的库）。
7. ~~**Bot 库是否适用同一裁剪**~~ **已定：不裁**。bot 库是 ActivityPub outbox 的内容源
   （`routes/bots.ts`），裁掉会改变对外可见历史；而且数据要挪回 PostgreSQL，CouchDB 只剩投影。

## 11. 落地进度

按"先把源库变有界、再切复制方式、最后删旧机制"的顺序推进（每步都保持测试全绿）：

- [x] **裁剪模块**：`couchdb/retention.ts` 的 `trimSourceToLatestN()`（视图降序取 N+1 行算下界 →
  分页删，单批 200 / 单次最多 10 批；拿不到下界就不裁）+ 13 个单测。
- [x] **接进抓取 worker**：写完新条目后裁剪一次；`compact` 不放在抓取路径上。
- [x] **`feeds.last_changed_at`**：新增列；worker 在"有新条目 / 首次缓存图标 / 裁掉了条目"时写它，
  `lastNewEntryAt` 只在真的拿到新内容时写（前端"最后更新"仍读它）。
- [x] **脏源判定改信号源**：feed 读 `lastChangedAt`（老行回退 `lastNewEntryAt`），bot 仍读 `lastNewEntryAt`。
  → "只裁剪删除、没有新增"的源现在也会触发同步（§3.3 场景 B 的回归钉子）。
- [x] **切复制方式**：`replicator.ts` 不再发送 `query_params`，filter 降级为"只挡设计文档"（§4.3）。
  → 每个 (用户 × 源) 的复制哈希变化，下一轮各自从 0 重扫一次源库（§4.4「聚合库不需要迁移」）。
- [x] **用户库停止剪枝**：`reconcileUserTimeline` 里的 `pruneOutsideRetention` 调用已删。
  → 用户库变成源库的精确镜像；那条"每用户每 5 分钟 O(用户库) 的扫描"没有了。
- [ ] **删残留**：`windowStartIso` / `looserBoundIso` / `retentionBoundIso` / `readSourceFloor` /
  `SourceFloor` / `normalizeBoundIso` / `pruneOutsideRetention` 及其三个子函数 / `restoreTombstonedEntries` /
  用户库 `timeline-maintain` 视图 / `syncSource` 里算下界的整段；
  schema 删 `user_timeline_settings.window_days|min_feed_entries`、`timeline_source_sync.window_days|min_entries|bound_iso`；
  **设置页的"窗口 / 保底条数"开关一起删**（现在还在但已经不起作用，会误导）。
- [ ] **上线注意（重要）**：镜像复制意味着**新订阅者的首拉 = 该源库当前全部内容**。
  存量 feed 库还积着全部历史（裁剪每次抓取最多删 2000 条，要几轮才收敛），
  所以正式切之前先跑一次**全量裁剪 sweep**（把每个 feed 库裁到 N），否则首拉可能拉几十万条。
  这一步在 dev 库上也要做，否则重启服务后第一批脏源同步会很重。
- [ ] **db:push + 回填**：`pnpm db:push` 加列，然后
  `UPDATE feeds SET last_changed_at = last_new_entry_at WHERE last_changed_at IS NULL;`
- [ ] **上线期**：配 `[compactions]`（风险 2），先在单源/小账号确认裁剪与删除传播收敛，再全量放开。
