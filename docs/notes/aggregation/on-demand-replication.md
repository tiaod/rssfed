# 聚合搬运为什么从「常驻复制」改成「按需一次性复制 + 水位」

**留档性质**：本文记的是 2026-10-11/12 那次改造的实测数字与取舍。**现行行为以代码与
[ARCHITECTURE.md](../../../ARCHITECTURE.md) 为准**；本文说的"当时"指改造前后，不代表现在还能照着抄。

前置：[`couchdb-replicator-aggregation.md`](couchdb-replicator-aggregation.md) 记录了上一版为什么选
CouchDB 复制器（那一步的结论 —— 二进制走 multipart、按源库修订谱系落库、过滤器必须用 JS —— 现在依然成立）。

## 结论先说

- **常驻（`continuous`）这个形态本身是根因**：一个 625 个源的账号 = 625 条常驻复制，它们同时追赶时
  会把 2 核机压死；而用 `max_jobs` 限流必然饿死（常驻任务跑到 running 就永不结束、不释放槽位）。
- 现在改为：**只在「源那边上次同步之后有过新内容」时，对该源跑一次 `POST /_replicate`**，
  并发由我们的 BullMQ 队列（`rss-timeline-sync`）控制。
- **水位判定不是优化而是必需**：单源"空转"一次也要 ~1.3s（会话建立占大头），625 个源就是十几分钟机器时间。
  稳态下一轮聚合一个复制请求都不发。

## 一、生产实测（2026-10-11，2 vCPU / 1967MB + swap 1599MB，一个账号 625 个源）

| 配置 | 结果 |
| --- | --- |
| `max_jobs=1000` `max_churn=100` | running ≈ 443、load **20.8**、264 条 crashing、目标库 3.5 分钟只涨 14 条（**不收敛**） |
| `max_jobs=50` `max_churn=20` | running=50 / pending=573 **一直不动**（573 个源永久饿死），后来 load 1.32、CouchDB CPU 15%、吞吐约 300 条/分钟 |
| `max_jobs=1000` `max_churn=20` | pending 归零，但 386 条 error |

错误原文集中在两类，指向两个不同的瓶颈：

1. `{replication_auth_error,{session_request_failed,"http://couchdb:5984/_session",...}}`
   `{changes_req_failed,sel_conn_closed}` `{error,req_timedout}` —— **CouchDB 自己的 HTTP 层被连接打满**
   （连复制器去 `/_session` 认证都失败）；
2. `filter_fetch_error: Could not open source database` + `changes_reader_died` ——
   **每条复制都要在源端拉起 couchjs 跑 JS 过滤器**，几百个进程叠起来先把机器压垮，于是连源库都打不开。

即"加并发 → 雪崩"、"限并发 → 饿死"是一个二选一，说明问题在「常驻」而不是参数。`deploy/couchdb-replicator.ini`
现在只把 `[replicator]` 当熔断用（兜住过渡期残留的常驻任务）。

## 二、本地探针：一次性复制的语义与成本（CouchDB 3.5.2，4 核）

用 `POST /_replicate`（同步调用）逐项验证，脚本见 `report/aggregation-ondemand/`（未纳入版本控制）：

| 探针 | 结果 |
| --- | --- |
| 裸库名当 source/target | `Could not open source database 'http://any:5984/...'` → `replication_auth_error`。**两端都必须是带凭据的完整 URL** |
| `filter: "main/timeline"` + `query_params.minPublishedAt` | 只有窗口内的文档被搬（窗口外的老条目留在源库） |
| **同参数**第二次调用 | 494ms、只搬 1 条新文档、两端 `_local/<hash>` 完全不变 = 从上次序号续传 |
| 改 `minPublishedAt`（换窗口下界） | **新哈希 = 从 0 重扫**：用 `_purge` 从目标端彻底清掉的文档又被搬回来了 |
| 成本（168 条 × 20KB 的源库） | 全量 3.5s；**增量 1 条 1.7s**；**无更新空转 1.3s**（会话建立占大头） |
| 变更投递 vs 投影 | 目标端的删除不会让复制器"重新送一遍"；只有 checkpoint 被重置（换库/换参数）才会重扫 |
| 过滤器写错参数名（叫 `since`） | 与 CouchDB 自己的 `since` 撞名，过滤器读到序号字符串，窗口静默失效 |

`docs_written` 只适合当日志：同参数续传时它也会把"重新读到的变更"计入（实测 6→7→8 逐个增长），
不代表"新增了几条"——"新增了几条"由客户端按 `update_seq` 数。

## 三、为什么用 `POST /_replicate`，而不是往 `_replicator` 塞一次性文档

- 塞文档就要经过复制器调度器：`max_jobs` / `max_churn` 又变成并发上限（正是要摆脱的东西），
  而且任务什么时候真正开跑只能靠轮询 `_scheduler/docs` 看。
- `POST /_replicate` 是**同步调用**：并发完全由调用方决定（我们的队列），返回值里直接有
  `history[0].docs_written` / `doc_write_failures`，失败能当场抛。
- checkpoint 机制两者一致（两端 `_local/<参数哈希>`），所以"同参数续传、换参数重扫"的语义不变。

## 四、水位放哪、怎么判

| 候选 | 为什么不选 |
| --- | --- |
| 用户库里的 `subscription:` 文档 | 那是**客户端也会写**的文档（PouchDB 双向同步），服务端往上写水位会和客户端抢修订、平白制造冲突 |
| `_local/` 文档（源库或用户库） | 一个源一行、id 还得编码 `bot:` 这类源 id；并发同步任务写同一个 doc 会丢更新 |
| **PostgreSQL 表 `timeline_source_sync`** | ✅ 事务、一处可见；判定"哪些源脏了"可以和订阅集合在一条 SQL 里比完 |

脏源判据（顺序即优先级）：**没有水位行**（新订阅）→ 脏；**`synced_at` 为空**（上次失败）→ 脏；
**`window_days` 与当前设置不一致**（换窗口）→ 脏；**源的 `lastNewEntryAt` 晚于 `synced_at`** → 脏。

两个容易写错的地方：

1. **`synced_at` 必须记"复制开始时刻"，不能记完成时刻**。抓取 worker 可能在复制进行中写入新条目：
   它在 t1 落库（`lastNewEntryAt = t1`），而复制的 changes 读的是 t0 之前的快照。若水位记 t2（完成时刻），
   则 `t1 < t2`，这条内容会被判成"已同步过"而**永久漏掉**（源以后不再出新条目的话）。记 t0 则它仍是脏源，
   下一轮补上——重复搬一次是幂等的，漏掉不是。
2. **`bound_iso`（窗口下界）在窗口不变时必须复用**。它是复制参数哈希的一部分：每次现算
   `now - N 天` 就等于每次换哈希、每次都从 0 全量重扫（实测 1.3s → 3.5s，源库越大差距越大）。

## 五、其他边界

- **换库（重建 / v1→v2 升级）必须作废水位**：新库是空的，还信水位的话"源那边没新内容"的源永远不会被搬，
  重建完等于什么都没有。判据是**新库没有 `_local/state`**。
- **退订竞态**：job 入队后用户可能已退订。任务里先读 `subscription:<sourceId>`，读不到（404）就跳过，
  否则会把刚清理掉的内容又搬回来。
- **遗留常驻任务的清理只做一次**：靠用户库 `_local/state.replicatorsPurged` 标记；删 `_replicator` 文档
  **不会**重置 checkpoint（checkpoint 在两端的 `_local/<hash>` 里），所以删了不会引发全量重扫。
- **`?force=1`**：跳过水位把该用户当前订阅的源全部重扫一遍。脚本/人工直接往源库写过东西时，
  PG 的 `lastNewEntryAt` 不会动，默认路径判不出"脏"，只能靠它。客户端不发这个参数（625 个源全量重扫
  是分钟级负载）。

## 六、现在怎么验证

- 单测：`packages/hono-server/src/__tests__/timeline-source-sync.test.ts`（脏源真值表、开始时刻竞态、
  换窗口重算、退订跳过、失败清空水位）。
- 端到端（真 CouchDB + 真 PG + 真 PouchDB）：
  `pnpm --filter @nuxt-client verify:timeline-sync` —— 现覆盖"稳态 `queued: 0` 一个复制请求都不发"、
  "同参数复用同一个 checkpoint"、"换库重搬后水位作废重扫"、"退订清理且强制重扫也不复活"。
