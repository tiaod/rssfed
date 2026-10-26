# 同步窗口（同步最近 N 天）的实测依据

> **留档说明**：本文原为 `report/sync-window/RESULTS.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。

时间：2026-10-03 · 环境：本机开发 CouchDB 3.5.2（`couchdb:3`）+ 真实 dev 数据。

## 为什么要「固定锚点」而不是每次现算 now - N 天

PouchDB 的复制 id 由 `generateReplicationId(src, target, opts)` 算出，**selector 的 JSON 也是输入之一**
（`pouchdb@9.0.0` lib/index.js `generateReplicationId`）。selector 里放一个跟着时钟走的时间戳，
复制 id 每天变一次 —— 旧 checkpoint 找不到，所有订阅源的 `_changes` 每天从头重扫一遍。

同一台机器上的开销实测：

| 数据 | 结果 |
| --- | --- |
| dev 数据集规模 | 642 个 feed 库 / 95,791 文档 / 磁盘 2.0GB（中位数 17 条、p90 188 条、最大 28,798 条） |
| 单源 `_changes` 全量扫描（1,240 条） | 63 个请求 / 306KB / 1,240 行（只有 id + rev） |
| 同上加 3 天窗口 selector | 8 个请求 / 38KB / 154 行 |
| 同上改成 `include_docs`（客户端函数过滤的代价） | 1,883KB（≈6 倍：窗口外条目的正文也要过一遍浏览器） |

按 250B/行估算：一次全量重扫 ≈ 23MB 元数据流量。每天来一次对移动端不可接受，因此
`utils/syncWindow` 把锚点按「库 id + 窗口档位」存下来，只生成一次。

窗口 selector 用服务端 Mango 过滤（`filter=_selector` + POST body `{selector}`，PouchDB 原生支持、
经 `/api/couchdb/proxy/*` 直通），比客户端函数过滤少传一个数量级的字节：窗口外条目的
id/rev 在服务端就被丢掉，正文与附件更不会进浏览器。

## 端到端验证

```
pnpm --filter @rssfed/nuxt-client test:integration    # 现行等价测试：真 CouchDB + 真 PouchDB
# 当时的两个命令已失效：verify:sync-window 已从 package.json 移除（客户端不再逐源按窗口复制，
# 聚合改在服务端完成，该链路现由 packages/nuxt-client/integration/timeline-sync.test.ts 覆盖）；
# report/sync-window/verify.mjs 已随 report/ 清理删除。
```

### 1. 真 CouchDB 上的过滤复制

对真 CouchDB 建临时库（1 个 FeedDoc + 3 条窗口内条目 + 2 条窗口外条目）、真 PouchDB 复制：

- 窗口内条目 + FeedDoc 落到本地，窗口外一条不落；条目附件随文档同步；
- 同一 selector 再复制：`docs_written=0`，服务端 `_local` checkpoint 数量不变（复制 id 未变）；
- 锚点前移（窗口调大）：服务端 `_local` 数量 +1（复制 id 变了，重开一条线），更早的条目被补回来。

### 2. 真浏览器（Playwright）

当时的 `report/sync-window/verify.mjs`（已随 `report/` 清理删除）：用 API 拿 session cookie 注入浏览器（不走登录页 —— 登录后会被
重定向到时间线，那是几百个源的首轮同步，既拖慢验证又可能顶满临时 profile 的 IndexedDB 配额），
先用 `page.route` 把该 feed 库的 `_changes` **第一页**拖慢，让「等同步」与「不等同步」两种行为
在时间轴上分得开（本机复制太快，不拖就都在 1s 内完成，测不出区别）。

**冷启动（本地无缓存）** —— 期望：不闪空态，等同步回来的内容直接上屏、不折叠：

- 同步被卡住的 1.2s 时的页面状态：`{loading:true, empty:false, probe:false}`（显示「加载中…」，
  既没有「暂无条目」空态，也没有内容）；
- 同步回来后探针条目**直接进入列表**，提示条未展开；
- `_changes` 带 `{"selector":{"$or":[{"type":"feed"},{"publishedAt":{"$gte":…}}]}}`，锚点 = now - 7 天；
- 增量水位与 `feedId|7` 锚点都落盘，且锚点和请求里的一致。

**热缓存（本地已有内容）** —— 期望：先上屏、不等同步，新条目折叠、不打扰阅读：

- 把该 feed 库的 `_changes` 拖慢 4s：缓存 **2033ms** 就已上屏（即内容不是这次同步来的）；
- 列表里没有还没同步完的新条目 C；列表保持缓存那一份不动；
- 新条目 C 到达后**折叠进「已同步 N 条」**，列表一个字没动；
- 点「查看」后 C 才上屏。

截图：`ui-settings-sync.png`（设置项）、`ui-feed-cold.png`、`ui-feed-warm-banner.png`、
`ui-feed-warm-applied.png`。脚本每次跑完会删掉自己写进 dev 库的探针条目。

唯一一条控制台噪音是 `Hydration completed but contains mismatches.`：设置项本来就从 localStorage
读，服务端渲染的是默认值，改了设置再刷新设置页必然报这一条（既有实现如此，与本次改动无关）。

## 已知取舍

- 调小窗口**不删除**本地已有条目（离线优先：能离线读的内容不因改设置消失），只是不再往回补更早的历史。
- 每个窗口档位是一条独立的 checkpoint 线：来回切换档位会在服务端留下每库每档一个 `_local` 文档
  （纯元数据），换来的是切回旧档位时 checkpoint 还能复用。
- 锚点存在 localStorage，与本地库同账号隔离。若浏览器只清掉 IndexedDB 而保留 localStorage，
  下次同步会按旧锚点把那段历史重新补回本地 —— 方向是「多拉」而不是「漏拉」，可接受。
