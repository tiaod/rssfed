# 调研留档

这里存的是**某次调研的结论**：实测数字、对比方法、以及当时为什么选 A 不选 B。

**它不是现行规范。** 每份文档记录的都是"当时量到什么"，代码随后可能已经改过；现行行为请以代码和
`ARCHITECTURE.md` 为准。想要某条结论对应的**当前**语义，读代码注释——那里的是最新的。

## 目录结构

| 子目录 | 收录什么 |
| --- | --- |
| [`sync/`](sync/) | 同步链路：水位判定、弹层状态、同步窗口锚点 |
| [`aggregation/`](aggregation/) | 服务端聚合搬运与 CouchDB 复制语义 |
| [`frontend-perf/`](frontend-perf/) | 前端列表渲染与性能基准 |
| [`evidence/`](evidence/) | 上述文档引用的原始数据 |

## 文档

### `sync/` —— 同步链路

| 文档 | 记录了什么问题 |
| --- | --- |
| [`sync-watermark-diagnosis.md`](sync/sync-watermark-diagnosis.md) | 为什么每次打开都有几百个订阅源要同步：根因链、次要问题与修复复测 |
| [`sync-tooltip-stale-progress.md`](sync/sync-tooltip-stale-progress.md) | 同步弹层残留「已同步 0%」的定位与验证 |
| [`sync-window-anchor.md`](sync/sync-window-anchor.md) | 同步窗口为什么用固定锚点，而不是每次现算 `now - N 天` |

### `aggregation/` —— 服务端聚合

| 文档 | 记录了什么问题 |
| --- | --- |
| [`couchdb-replicator-aggregation.md`](aggregation/couchdb-replicator-aggregation.md) | 聚合搬运为什么改用 CouchDB 复制器；复制语义的 5 条边界与三条路线取舍 |

### `frontend-perf/` —— 前端性能

| 文档 | 记录了什么问题 |
| --- | --- |
| [`sidebar-load-perf.md`](frontend-perf/sidebar-load-perf.md) | 626 源真实规模下侧边栏加载性能的归因、优化实施与复测 |
| [`pouchdb-sidebar-icon-bench.md`](frontend-perf/pouchdb-sidebar-icon-bench.md) | 侧边栏订阅图标加载：主线程 vs Web Worker 微基准 |
| [`pouchdb-sidebar-icon-bench-probes.md`](frontend-perf/pouchdb-sidebar-icon-bench-probes.md) | 上述基准的补充探针与三份数据的合并结论 |

## 来源与清理说明（2026-10-11）

这些文档原本散落在仓库根的 `report/` —— 一个**未纳入版本控制**（`.gitignore` 忽略）的调试目录。
因为它不受版本控制，一次清理就可能永久丢掉，所以把其中的结论性文档移到这里留档。

同一次清理还删除了 `report/` 下约 95MB 的临时产物：Chrome profile 转储、全部截图、各目录的复现
脚本（`probe*.mjs` / `verify.mjs` / `bench.mjs` / `measure-*.mjs` / `check*.mjs`）以及一份含真实
`user_id` 的 Bot 备份。

**因此本文档里"复现方式"一节列出的脚本与截图都已不存在**，各文件开头的留档说明也标注了这一点。
结论与实测数字保留，重跑需要按描述重写脚本。

## 原始数据

| 路径 | 内容 | 是否随版本控制 |
| --- | --- | --- |
| [`evidence/admin-subs-stats.sql`](evidence/admin-subs-stats.sql) | admin 订阅规模统计的查询与数据 | ✅ 在 `docs/` 下，会纳入 |
| `report/aggregation-replication/probe-{1..4}-output.txt` | 四组复制语义探针的原始 stdout | ❌ 只在本机 |
| `report/image-cache-diagnosis/result.txt` | 正文图片缓存诊断的扫描输出 | ❌ 只在本机 |

> 后两项按「原始证据留在 `report/`」处理：它们是诊断脚本的输出位置，代码注释（`src/images/fetch.ts`、
> `src/rss/entry-images.ts`）也直接指向 `report/image-cache-diagnosis`，移走会让代码注释失准。
> 代价是新克隆的仓库里没有它们，上表已如实标注。
