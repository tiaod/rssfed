# 同步判定诊断：为什么每次打开都有几百个订阅源要同步

> **留档说明**：本文原为 `report/sync-diagnosis/RESULTS.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。
> 统计查询与数据保留在 [`admin-subs-stats.sql`](../evidence/admin-subs-stats.sql)。

日期：2026-09-30　环境：本机 dev（Nuxt :3000 + Hono :3001 + Postgres/Redis/CouchDB 容器）
账号：admin@example.com（626 个订阅源）

## 一、结论先说

1. **「只同步有新条目的源」这段判断没有写错**，但它被另一个问题打穿了：
   复制失败时**不记录水位**，于是失败的源永远停在「从未同步过」，
   每次打开页面都被重新全量入队 —— 用户看到的「几百个要同步」其实是**全量重试**。
2. 触发失败的直接原因是集中条目库写入时 IndexedDB 报
   `indexed_db_went_bad / QuotaExceededError`，PouchDB 库进入 global failure 后，
   后续复制**立即**失败（错误对象 message 为空，前端显示「未知错误」）。
3. 用户判断是对的：这 484 个被入队的源里，真正有新条目的只有几十个。

## 二、当前同步逻辑（桌面检查）

后端：

- Worker 每 `FETCH_INTERVAL`（默认 15min，`packages/hono-server/src/workers/index.ts`）
  对全部 `status=active` 的 feed 入队抓取。
- 抓到新条目（或首次缓存图标）时写 `feeds.lastNewEntryAt = now()`
  （`workers/index.ts` 第 32-37 行）。

前端（`packages/nuxt-client/app/composables/usePouchDb.ts`）：

- 打开时间线 → `GET /api/feeds/subscriptions` 拿订阅列表（含每个源的 `lastNewEntryAt`）
  → `syncFeedsIfChanged()`。
- 逐源判定 `needsSync(feedId, lastNewEntryAt, 本地水位表)`
  （`app/utils/syncDecision.ts`）：
  - `lastNewEntryAt` 缺失 → 不同步（服务端从未抓到过内容）；
  - 本地水位表无该源记录 → 同步（首次 / 新订阅）；
  - `lastNewEntryAt > 本地水位` → 同步。
- 需要同步的源走并发上限 2 的复制队列（远端 feed 库 → 本地集中库）。
- **复制成功后**才 `markSynced()` 写 localStorage 水位表
  （key：`rssfed-synced-feeds-<userId>`）；失败不写。

## 三、实测数据

### 3.1 服务端真实「有新条目」的源有多少（admin 的 626 个订阅）

```sql
with subs(feed_id) as (values (...626 个 feedId...))
select count(*) as admin_subs,
       count(f.last_new_entry_at) as with_lna,
       count(*) filter (where f.last_new_entry_at > now() - interval '15 minutes') as new_15m,
       count(*) filter (where f.last_new_entry_at > now() - interval '1 hour')     as new_1h,
       count(*) filter (where f.last_new_entry_at > now() - interval '1 day')      as new_1d,
       count(*) filter (where f.last_new_entry_at > now() - interval '7 day')      as new_7d
from subs s left join feeds f on f.id = s.feed_id;
```

结果（见 [`admin-subs-stats.sql`](../evidence/admin-subs-stats.sql)）：

| admin 订阅 | 有 lastNewEntryAt | 近 15min | 近 1h | 近 1d | 近 7d |
|---|---|---|---|---|---|
| 626 | 484 | 11 | 26 | 208 | 482 |

即：任一时刻真正有新内容的只有几十个源（用户感知「就几十条」是准确的），
但「曾经有过新条目」的源有 484 个 —— 一旦水位表缺失，这 484 个就全被判为需要同步。

### 3.2 浏览器实测（Playwright，全新本地存储）

通过 `report/sync-diagnosis/probe8.mjs`（需临时在 `usePouchDb.ts` 埋点，
见「复现方式」）采集：

第 1 轮（首次打开时间线，水位表 0 条）：

```
syncFeedsIfChanged.start  { feeds: 626, syncedEntries: 0 }
入队 needSync = 484
复制成功 = 115，写水位 = 115
复制失败 = 369（368 × Error(message 空) + 1 × indexed_db_went_bad / QuotaExceededError）
switchUser { from: null, to: <uid>, queue: 0 }   ← 正常初始化，非中断
进度条：正在同步 2 个 · 剩余 377 个（22%）
```

第 2 轮（刷新页面，水位表 115 条）：

```
syncFeedsIfChanged.start  { feeds: 626, syncedEntries: 115 }
入队 needSync = 369
复制成功 = 0，复制失败 = 369   ← 全部立即失败
```

存储用量：`usage 417MB / quota 2.56GB`。

### 3.3 对照：真正发起复制的库 vs 水位记录

`probe6.mjs`（用 `/api/couchdb/targets` 建 feedId→库名映射）：

```
真正发起复制的库 138 → 订阅源 117；水位表 115 条
复制了但没记水位：2 个（进行中/失败）
```

说明成功那部分的水位记录是自洽的 —— 问题只在**失败的那一大批从不记水位**。

## 四、根因链

1. 首轮（或本地缓存被清后）水位表为空 → 484 个「曾经有过新条目」的源全部入队。
2. 484 个源的条目 + AVIF 图片附件一次性写入本地集中库，
   在约第 115 个源处触发 `QuotaExceededError`，PouchDB 库进入 **global failure**。
3. 之后 368 个复制**立即**失败（错误 message 为空 → 前端文案「未知错误」）。
   失败路径不写水位，也不做任何退避/熔断。
4. 下次打开页面：这 369 个源依旧「本地无水位」→ 又被判为需要同步 → 再次全部失败。
   **每次打开都是几百个源、且这轮几乎不会成功**。
5. UI 把「本轮入队数」当分母（`正在同步 X · 剩余 N（%）`），
   用户自然会以为这几百个源都有新内容。

### 次要问题

- `needsSync()` 用**服务端**时间戳 `lastNewEntryAt` 与**浏览器**记录的
  `new Date().toISOString()` 直接比大小，跨机器时钟偏差会造成误判。
  更稳的做法是记录「上次同步时看到的 `lastNewEntryAt` 值」再比较。
- `SyncStatusIndicator` 成功态显示「共 N 个订阅源」，N 是会话内累积
  同步过的库数（`syncStatuses` 不清理），不代表本轮范围。

## 五、修复建议（按优先级）

1. **失败要能收敛**：失败也记录 `lastAttemptAt`（或失败次数 + 指数退避），
   「从未同步过」的判定改为「从未成功过且距上次尝试超过 N 分钟」，
   避免每轮对同一批失败源全量重试。
2. **首轮分批**：水位表为空/本地库重建时按批（如 50 个）入队，批间让出主线程，
   避免几百 MB 一次性写入把 IndexedDB 打崩。
3. **识别存储故障**：捕获 `QuotaExceededError` / `indexed_db_went_bad` /
   PouchDB global failure 时立即停止本轮、提示用户「本地缓存已满，去设置里重置本地缓存」，
   而不是把剩余几百个任务快速失败掉。
4. **控制附件体积**：495MB 主要是 AVIF 图片附件，考虑按需拉取或收紧全局默认上限
   （per-feed 策略已存在，见 `rss/entry-images.ts`）。
5. **水位比较用服务端值**：记录上次看到的 `lastNewEntryAt`，而不是本地时间戳。
6. **UI 语义**：区分「待检查的源」与「确有更新的源」，避免把 484 个待检查显示成「要同步」。

### 关于「把水位表挪到独立 PouchDB」的结论（已排除）

实测存储归属：localStorage 总共 **12.7KB**（水位表 11.8KB），而 IndexedDB 的
`_pouch_rssfed-entries-<uid>` 是 **22531 文档 + 11198 附件 / 495MB**。
报错是 `indexed_db_went_bad / QuotaExceededError`，与 localStorage 无关；
且配额是 origin 级的，入库追踪反而会让水位表自己也写不进。故水位表保留在 localStorage。

## 六、已实施的修复（本次改动）

| 文件 | 改动 |
|---|---|
| `app/utils/syncDecision.ts` | 水位记录 v2：记录「上次看到的服务端 `lastNewEntryAt`」，不再比本地时钟；新增失败退避（30s 起、指数退避、封顶 10min）；新增 `isStorageFailure()` 识别配额/IndexedDB 故障 |
| `app/composables/usePouchDb.ts` | 失败写退避表（成功清除）；复制 `batch_size` 100 → 20；按 50 个源分批入队，批间可被暂停/熔断中断；命中存储故障即熔断本轮并停止后续批次；导出 `storageBroken`；重置本地缓存时清退避与熔断 |
| `app/utils/localDbName.ts` | 新增按账号隔离的 `syncRetryKey` |
| `app/utils/syncStatusSummary.ts` | 新增 `storage-error` 状态（优先级最高）与文案 |
| `app/components/SyncStatusIndicator.vue` | 存储故障显示为警示图标；点击 = 重置本地缓存并重新同步 |
| `app/components/SyncProgressBar.vue` | 熔断时常驻错误条，不再假装还在同步 |
| `app/composables/useManualSync.ts` | 熔断时给出可操作提示，而不是罗列几百条失败 |

配套测试：`usePouchDb.syncGate.test.ts`（新增，锁定增量/退避/熔断三条规则）、
`syncDecision.test.ts`、`syncStatusSummary.test.ts`、`SyncStatusIndicator.test.ts`。
`pnpm test` 207 passed、`pnpm typecheck`、`pnpm lint` 均通过。

顺带修了 `EntryDetailModal.test.ts` 的一个既有 flaky：该用例手动接管 rAF 后只推一帧，
并发跑测试时会偶发看不到「槽位就绪后的对齐」（新增测试文件改变了调度，暴露了它）。
改为最多推 5 帧，断言不变；加固后连续 8 次全量运行全绿。

## 七、修复效果实测（`probe10-after-fix.mjs`，admin 账号）

| 轮次 | 修复前真正发起复制的库数 | 修复后 |
|---|---|---|
| 第 1 轮（首次打开） | 484（115 成功 + 369 失败） | 118，随即熔断并提示「本地缓存写入失败…」 |
| 第 2 轮（刷新） | 369，且 **369 个全部失败** | **3**，且立即熔断 |
| 第 3 轮（再刷新） | 369 全部失败 | **3** |

水位表 115 条全部带 v2 的 `seen` 服务端值；退避表正确累积失败次数
（`attempts: 1 → 2`），同一批坏源不再每轮全量重试。

> 说明：本机无头 Chromium 的 IndexedDB 配额在这个数据集（626 个源、495MB 附件）下
> 必然触顶，因此重置本地缓存后会再次命中；真实浏览器配额通常按磁盘可用空间计算，
> 一般不会。要彻底摆脱该约束需要「附件不进本地库 / 按需拉取」，属于产品行为变更，未在本次实施。

## 八、复现方式

```bash
# 1) 在 packages/nuxt-client/app/composables/usePouchDb.ts 临时加 __syncLog 埋点
#    （见 probe8.mjs 读取的事件名：syncFeedsIfChanged.start / enqueued /
#      enqueue / replicateDb.start / replicateDb.ok / replicateDb.error / markSynced / switchUser）
# 2) 起 dev：pnpm dev:all（前端 :3000 后端 :3001）
# 3) 跑探针
WAIT_MS=80000 node report/sync-diagnosis/probe8.mjs
# 4) 记得还原：git checkout -- packages/nuxt-client/app/composables/usePouchDb.ts
```

| 脚本 | 用途 | 依赖 |
|---|---|---|
| `probe2.mjs` | 采样进度条/水位表/请求库数（两轮） | 无埋点 |
| `probe3.mjs` | 统计 localStorage 写入次数 | 无埋点 |
| `probe4.mjs` | 校验水位表读/写 key 是否一致 | 无埋点 |
| `probe5.mjs` | 各订阅库 HTTP 状态分布 | 无埋点 |
| `probe6.mjs` | 真正发起复制的库 vs 水位记录对照 | 需 `/api/couchdb/targets` 映射文件 + 无埋点 |
| `probe7/8.mjs` | 队列行为与失败原因聚合 | 需临时 `__syncLog` 埋点 |
| `admin-subs-stats.sql` | 按 admin 订阅统计新条目分布 | Postgres |
