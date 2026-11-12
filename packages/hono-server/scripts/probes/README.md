# CouchDB 复制语义探针（调研留档）

这些脚本是 2026-10 存储层重构期间一次性跑过的实测探针，用来验证 CouchDB 复制器的行为边界。
**它们是调研记录，不是现行实现的测试** —— 现行行为以 `src/couchdb/*.ts` 与
[`ARCHITECTURE.md`](../../../../ARCHITECTURE.md) 为准。

运行方式：`node packages/hono-server/scripts/probes/<脚本>`（需要本机 CouchDB 与 admin 凭据；
脚本自建临时库，跑完自行清理）。

| 探针 | 验证什么 | 结论今天还成立吗 |
| --- | --- | --- |
| `probe-a-purge-live-doc.mjs` | `_purge` 活文档后附件字节要 `_compact` 才回收 | ✅ 成立 |
| `probe-b-purge-vs-replication.mjs` | 源端 purge 之后，增量复制/全量重扫会不会复活 | ✅ 成立 |
| `probe-b2-checkpoint.mjs` | checkpoint 由复制参数哈希决定；换参数 = 从 0 重扫 | ✅ 成立（这是"selector 必须常量"的依据） |
| `probe-c-pouchdb-compact-vs-purge.mjs` | PouchDB 的 `compact()` 安全、`purge()` 会抹修订记忆 | ✅ 成立 |
| `probe-d-window-size.mjs` | 旧「按窗口过滤」方案的体积测算 | ⚠️ 方案已废弃（不再有窗口参数） |
| `probe-e-target-purge-resurrection.mjs` | 目标端 purge 后，源端重扫会不会搬回来 | ✅ 成立（现行"汇聚库也 purge"正是用它确认的） |
| `probe-f-filter-carries-deletions.mjs` | JS filter 能带走删除、selector 不能 | ✅ 成立，但**结论导向相反**：当时据此选了 filter + 删除传播；现在反过来利用"selector 不搬删除"，改由两侧各自 `_purge` 保留 |

## 为什么 probe-f 的结论"成立但被反向使用"

`probe-f` 证明的是「JS filter 会带走删除、Mango selector 不会」—— 这个事实没变。
变的是**我们想要什么**：旧方案要"删除传播"以实现精确镜像，代价是每个删除在每个用户库
都留一个墓碑（实测一个账号 42,262 个，占 90%，首拉 21.7 秒）。现在**接受墓碑静默丢失**，
让两侧各自裁剪 —— 所以改用 selector，`probe-f` 的结论依然成立，只是不再支撑当初那个决定。

详见 `docs/notes/aggregation/source-side-retention-plan.md` 顶部的取代说明。
