# PouchDB 侧边栏订阅图标加载：主线程 vs Web Worker 微基准

> **留档说明**：本文原为 `report/worker-pouch-bench/RESULTS.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。

> 目标代码路径：`packages/nuxt-client/app/components/FeedNavigation.vue` 的 `loadFeeds()`
> → `usePouchDb.listSubscriptions()`（`getUserStateDb().allDocs({include_docs:true, startkey:"subscription:", endkey:"subscription:\uffff"})`）
> → 对每个订阅源 `getFeedImageUrl(f.id)`（`getEntriesDb().get(feedId)` → `getAttachment(feedId, imageCached.attachment)` → `URL.createObjectURL(blob)`）。

## 0. 运行环境与数据

- 运行时间：2026-09-23T12:53:15.617Z → 2026-09-23T12:54:16.238Z
- 主机：Node v24.19.0 / linux x64 / 4 vCPU / 7.8 GB
- 浏览器：Playwright 1.63.0，Chromium 153.0.8010.12（headless）
- PouchDB 9.0.0（浏览器单文件 dist `/pouchdb.js`），实际 adapter：`idb`
- 附件：每源一张 24499 字节的有效 PNG（目标 20KB 量级），84×84 可解码；共 100 / 300 / 500 个 feed 文档 + 同数量 `subscription:` 文档
- 每项测量重复 5 次（postMessage 微基准 3 次），表内为中位数，括号是 min–max；每个 (场景, N, 重复) 都用全新库名重新写入种子数据，无跨轮污染
- 页面：`bench.html`（主线程场景）+ `bench-worker.js`（Worker 场景），静态服务器 `http://127.0.0.1:8899`，全部产物在 `report/worker-pouch-bench/`

## 结论速览

- **当前实现（场景 A，N=300）**：墙钟中位 82 (79.4–85.3)ms；主线程阻塞中位 0 (0–52)ms，但 5 次里有 2 次出现 52ms 级长任务（≥100ms 的 0 段）；最长帧间隔中位 52.7 (51.2–64.2)ms、观测最大 64.2ms。**长任务是偶发的，帧停顿则每次都出现**。
- **最省的是 B2（延迟加载图标，N=300）**：一次 allDocs 拿元信息 + 远程 URL 占位，墙钟 10.1 (9.3–10.6)ms、主线程阻塞 0ms。
- **要「本地 blob 图标优先」就用 C2**：附件读取与 createObjectURL 都放 Worker，只回传 URL 字符串；N=300 主线程阻塞 0ms、最长帧间隔 16.9 (16.8–18)ms（正常 60fps）；worker 创建的 blob URL 在主线程 <img> 里实测可正常解码，terminate 之后依然可用。
- **C1（回传 Blob）在大 N 下反而会阻塞主线程**：N=500 时主线程反序列化 N 个 Blob 并连续 createObjectURL，形成 68 (66–71)ms 长任务；同一规模 C2 为 0ms。
- **单位成本大头是 createObjectURL（约 148.5µs/次）**，不是 IDB 读取（0.2–0.3ms/次，多数时间在等 IO）；20KB Blob 的 postMessage 往返仅 47µs，搬运本身很便宜。

## 1. 方法学对照（先证明口径可信，再谈数字）

四种主线程停顿口径同时采样：`longtask` PerformanceObserver、`long-animation-frame`（LoAF）、rAF 回调间隔、`setTimeout(10)` 心跳间隔。
阳性对照：主线程忙等 200ms；阴性对照：空闲 300ms。

| 重复 | 忙等实测 (ms) | longtask 检出 | LoAF 检出 | rAF 检出 | timer 检出 | 空闲对照干净 |
|---|---|---|---|---|---|---|
| 0 | 200 | ✅ (max 200ms) | ❌ | ✅ (200.3ms) | ✅ (200.5ms) | ✅ |
| 1 | 200 | ✅ (max 200ms) | ❌ | ✅ (200.1ms) | ✅ (200.2ms) | ✅ |
| 2 | 200 | ✅ (max 200ms) | ❌ | ✅ (200.1ms) | ✅ (200.2ms) | ✅ |
| 3 | 200 | ✅ (max 200ms) | ❌ | ✅ (200.2ms) | ✅ (200.1ms) | ✅ |
| 4 | 200 | ✅ (max 200ms) | ❌ | ✅ (200.1ms) | ✅ (200.2ms) | ✅ |

**结论**：`longtask`、rAF、timer 三种口径都能正确检出 200ms 阻塞、空闲时都不误报，因此下表的主线程阻塞数字可信；
`long-animation-frame` 在本环境（headless Chromium）不产生条目，不使用。
一个容易踩的坑：调用 `observer.takeRecords()` 的时机必须晚于「忙等所在任务结束」（本次实现里是等一个 rAF + 一个宏任务之后再取），
否则长任务 entry 还没生成，会得到「主线程零阻塞」的假象——这正是本基准早期版本误判的原因。

- 另：阴性对照下 rAF 中位间隔 16.6ms，timer 中位间隔 10.1ms，说明 headless 下 60fps 渲染循环与定时器都正常工作。

## 2. 单步成本探针（解释「为什么主线程没被阻塞」）

| 指标 | 实测 |
|---|---|
| `get(feedId)` 单次（串行中位） | 0.2 ms（min 0.2 / max 0.4，20 次） |
| `getAttachment(feedId, attach)` 单次（串行中位） | 0.3 ms（min 0.3 / max 0.5） |
| `URL.createObjectURL(blob)` | **148.5 µs/次**（2000 次共 296.9 ms） |
| Blob→base64（FileReader dataURL，对照） | 0.4 ms/次 |
| `getAttachment` 返回值类型 | `[object Blob]` / ctor=`Blob` / 24499 B / type=image/png |
| PouchDB 视角库名 | `bench-probe-1790167999850-460793-entries`（doc_count=20） |
| IndexedDB 实际库名 | `_pouch_bench-probe-1790167999850-460793-entries@5`、`_pouch_bench-probe-1790167999850-460793-entries-state@5` |
| 底层 store 直接取样 | 未取到 —— openAndSample 内部超时 |

- `getAttachment` 返回的是**原生 Blob**（不是 base64 字符串再解码），PouchDB 的 idb adapter 在 IndexedDB 支持 Blob 时以二进制存放，
  所以整个链路没有 base64 解码的 CPU 开销（作为对照，如果走 base64，每次约 0.4ms，300 张图就是 ~111ms 主线程 CPU）。
- 单次 IDB 读取都在 **零点几毫秒**；主线程上的主要单位成本反而是 `createObjectURL`：**148.5 µs/次**，
  N=300 就是 ~45ms，N=500 约 74ms —— 这是 Worker 方案（尤其 C2）真正能搬走的东西。
- 底层 store 直接取样失败：即使关闭 PouchDB 连接、用 `indexedDB.databases()` 拿到的真实库名 `_pouch_<name>` 去 `indexedDB.open()`，
  该请求在 5s 内始终不回调（`indexedDB.databases()` 本身可用）。这是本环境的一个实测限制，如实记录；附件以 Blob 形式存取由上面的返回值类型证据支持。

## 3. 主对比表

| 场景 | N | 墙钟 (ms) | 主线程阻塞总时长 (ms) | 最长单次阻塞 (ms) | ≥100ms 长任务 | rAF>50ms 停顿总时长 (ms) | 最长 rAF 间隔 (ms) | 最长 timer 间隔 (ms) |
|---|---|---|---|---|---|---|---|---|
| A 当前实现（Promise.all 并发） | 100 | 27.6 (25.9–32.3) | 0 | 0 | 0 | 0 | 22.8 (17.6–26.6) | 18.6 (17.6–26.6) |
| B 批量 allDocs + 每批 8 个分帧 | 100 | 194.2 (191.7–200.4) | 0 | 0 | 0 | 0 | 16.8 (16.8–17) | 10.8 (10.2–11.3) |
| B2 只读元信息、远程 URL 占位 | 100 | 3.8 (3.5–4.4) | 0 | 0 | 0 | 0 | 12.2 (4–12.7) | 3.8 (3.5–4.4) |
| C1 Worker 回传 Blob | 100 | 31.7 (31.4–32) | 0 | 0 | 0 | 0 | 21.5 (19.7–24.2) | 22 (19.9–22.2) |
| C2 Worker 回传 blob URL | 100 | 28.1 (27.1–29.2) | 0 | 0 | 0 | 0 | 16.7 (16.6–16.9) | 10.1 |
| A 当前实现（Promise.all 并发） | 300 | 82 (79.4–85.3) | 0 (0–52) | 0 (0–52) | 0 | 54.5 (50.9–59) | 52.7 (51.2–64.2) | 54.5 (50.9–59) |
| B 批量 allDocs + 每批 8 个分帧 | 300 | 617.5 (613.2–639.6) | 0 | 0 | 0 | 0 | 16.9 (16.8–17) | 11.1 (10.9–13.5) |
| B2 只读元信息、远程 URL 占位 | 300 | 10.1 (9.3–10.6) | 0 | 0 | 0 | 0 | 12.5 (9.2–16.9) | 10 (9.3–10.1) |
| C1 Worker 回传 Blob | 300 | 93.2 (89.2–93.6) | 0 | 0 | 0 | 0 (0–50.4) | 44.4 (41.2–56.4) | 49.5 (43–50.4) |
| C2 Worker 回传 blob URL | 300 | 77.6 (74.4–79.5) | 0 | 0 | 0 | 0 | 16.9 (16.8–18) | 10.4 (10.2–12.9) |
| A 当前实现（Promise.all 并发） | 500 | 135.6 (134.3–138.7) | 82 (0–84) | 82 (0–84) | 0 | 89.3 (59.1–96.5) | 95.9 (63.7–97.8) | 89.3 (59.1–96.5) |
| B 批量 allDocs + 每批 8 个分帧 | 500 | 1042.1 (1040.5–1052.9) | 0 | 0 | 0 | 0 | 16.9 (16.8–17) | 11.7 (11.4–13.2) |
| B2 只读元信息、远程 URL 占位 | 500 | 18 (17–20.1) | 0 | 0 | 0 | 0 | 16.6 (16.2–16.8) | 11.2 (10.6–13.8) |
| C1 Worker 回传 Blob | 500 | 154.5 (149.2–158.1) | 68 (66–71) | 68 (66–71) | 0 | 75 (69.7–79.2) | 77.4 (70.1–82.8) | 75 (69.7–79.2) |
| C2 Worker 回传 blob URL | 500 | 130.7 (127.4–135.4) | 0 | 0 | 0 | 0 | 16.8 (16.8–20.9) | 11 (10.2–12.6) |

主线程阻塞口径 = 测量窗口内 `longtask`（>50ms 任务）时长之和。`0` 表示整段测量**没有出现任何 >50ms 的主线程任务**，
不代表零成本——低于 50ms 的分散工作不在该口径内（这正是下面用 rAF/timer 间隔交叉验证的原因）。

- 场景 B 的 `allDocs({include_docs:true, keys})` 实测：100 个 FeedDoc 全部返回，其中 100 个只带 attachment stub —— 证实「allDocs 拿不到附件二进制」，
  所以 B 仍必须逐个 `getAttachment`（100 次，失败 0 次），没有绕过附件读取这一步。

## 4. 场景 C 的耗时拆分（worker 侧 vs 主线程侧）

| 场景 | N | 端到端墙钟 (ms) | worker 内部耗时 (ms) | 主线程「收到结果」耗时 (ms) | 主线程后处理 (ms) | 主线程阻塞总时长 (ms) |
|---|---|---|---|---|---|---|
| C1 Worker 回传 Blob | 100 | 31.7 (31.4–32) | 16.8 (16.2–17.2) | 17.3 (16.4–17.6) | 14.4 (14.3–15) | 0 |
| C2 Worker 回传 blob URL | 100 | 28.1 (27.1–29.2) | 27.6 (26.8–28.8) | 27.8 (27.1–29.2) | 0 (0–0.3) | 0 |
| C1 Worker 回传 Blob | 300 | 93.2 (89.2–93.6) | 51.5 (47.3–52.7) | 52 (47.8–53.3) | 40.9 (40.3–42) | 0 |
| C2 Worker 回传 blob URL | 300 | 77.6 (74.4–79.5) | 77.3 (74–79.1) | 77.6 (74.4–79.5) | 0 | 0 |
| C1 Worker 回传 Blob | 500 | 154.5 (149.2–158.1) | 85.4 (81.2–87.6) | 86 (81.7–88.2) | 67.9 (66.3–70.8) | 68 (66–71) |
| C2 Worker 回传 blob URL | 500 | 130.7 (127.4–135.4) | 130.2 (126.7–134.8) | 130.7 (127.4–135.4) | 0 (0–0.1) | 0 |

- C1：worker 里 `get` + `getAttachment`，**Blob 结构化克隆**回主线程，主线程再 `createObjectURL`。
- C2：worker 里连 `createObjectURL` 一起做，**只回传 URL 字符串**，主线程不做任何附件相关操作。

## 5. worker 创建的 blob URL 在主线程能否用（实证）

- N=100（C2）：主线程用真实 `<img src="blob:...">` 加载 worker 里创建的 URL —— worker 存活时：5/5 次 decode 成功，naturalWidth/Height = 84x84；`worker.terminate()` 之后再次加载同一 URL：5/5 次 decode 成功，naturalWidth/Height = 84x84
- N=300（C2）：主线程用真实 `<img src="blob:...">` 加载 worker 里创建的 URL —— worker 存活时：5/5 次 decode 成功，naturalWidth/Height = 84x84；`worker.terminate()` 之后再次加载同一 URL：5/5 次 decode 成功，naturalWidth/Height = 84x84
- N=500（C2）：主线程用真实 `<img src="blob:...">` 加载 worker 里创建的 URL —— worker 存活时：5/5 次 decode 成功，naturalWidth/Height = 84x84；`worker.terminate()` 之后再次加载同一 URL：5/5 次 decode 成功，naturalWidth/Height = 84x84
- N=100（A 对照，主线程自建 URL）：5/5 次 decode 成功，naturalWidth/Height = 84x84
- N=300（A 对照，主线程自建 URL）：5/5 次 decode 成功，naturalWidth/Height = 84x84
- N=500（A 对照，主线程自建 URL）：5/5 次 decode 成功，naturalWidth/Height = 84x84

结论：**worker 里 `URL.createObjectURL()` 得到的 blob URL 可以直接在主线程的 `<img>` 里正常解码显示**（naturalWidth > 0），
且该 URL 的生命周期不依赖创建它的 worker —— `terminate()` 之后仍然可加载（实测一致）。

## 6. postMessage 克隆开销微基准（20KB 载荷，500 次往返）

| 回传载荷 | 500 次往返墙钟 (ms) | 单次往返 (µs) | 主线程阻塞总时长 (ms) | 最长单次阻塞 (ms) |
|---|---|---|---|---|
| Blob（结构化克隆） | 23.5 (23.5–24.6) | 47 (47–49.2) | 0 | 0 |
| ArrayBuffer（结构化克隆 = 真实拷贝） | 33.3 (27.7–37.7) | 66.6 (55.4–75.4) | 0 | 0 |
| ArrayBuffer（Transferable，零拷贝） | 31.4 (28–38.6) | 62.8 (56–77.2) | 0 | 0 |
| URL 字符串（约 60 B） | 17.3 (17.2–22) | 34.6 (34.4–44) | 0 | 0 |

（每次往返 20480 字节载荷 × 500 次；这个数字要跟「省下来的 createObjectURL ~148.5µs/张」一起看。）

## 7. 测量次数与失败情况

| 场景 | N | 计划 | 成功 | 失败 | 错误 |
|---|---|---|---|---|---|
| A 当前实现（Promise.all 并发） | 100 | 5 | 5 | 0 | — |
| B 批量 allDocs + 每批 8 个分帧 | 100 | 5 | 5 | 0 | — |
| B2 只读元信息、远程 URL 占位 | 100 | 5 | 5 | 0 | — |
| C1 Worker 回传 Blob | 100 | 5 | 5 | 0 | — |
| C2 Worker 回传 blob URL | 100 | 5 | 5 | 0 | — |
| A 当前实现（Promise.all 并发） | 300 | 5 | 5 | 0 | — |
| B 批量 allDocs + 每批 8 个分帧 | 300 | 5 | 5 | 0 | — |
| B2 只读元信息、远程 URL 占位 | 300 | 5 | 5 | 0 | — |
| C1 Worker 回传 Blob | 300 | 5 | 5 | 0 | — |
| C2 Worker 回传 blob URL | 300 | 5 | 5 | 0 | — |
| A 当前实现（Promise.all 并发） | 500 | 5 | 5 | 0 | — |
| B 批量 allDocs + 每批 8 个分帧 | 500 | 5 | 5 | 0 | — |
| B2 只读元信息、远程 URL 占位 | 500 | 5 | 5 | 0 | — |
| C1 Worker 回传 Blob | 500 | 5 | 5 | 0 | — |
| C2 Worker 回传 blob URL | 500 | 5 | 5 | 0 | — |

- 运行期间无 console error、无未捕获异常、无请求失败。

## 8. 观察与结论

### 8.1 场景 A（当前实现）的主线程阻塞到底有多大？
- N=100：墙钟中位 27.6ms；主线程阻塞中位 0ms、观测最大 0ms（5 次里 0 次出现 >50ms 长任务）；最长帧间隔中位 22.8ms、观测最大 26.6ms。
- N=300：墙钟中位 82ms；主线程阻塞中位 0ms、观测最大 52ms（5 次里 2 次出现 >50ms 长任务）；最长帧间隔中位 52.7ms、观测最大 64.2ms。
- N=500：墙钟中位 135.6ms；主线程阻塞中位 82ms、观测最大 84ms（5 次里 4 次出现 >50ms 长任务）；最长帧间隔中位 95.9ms、观测最大 97.8ms。

**N=300 的判断（回答「是否可能造成用户可感知的卡顿」）**：
- ≥100ms 的长任务：5 次重复里 **0 段**；最长单次观测值 52ms，落在 50–60ms 区间，5 次里出现 2 次（偶发）。
- 帧间隔口径更稳定：A 的最长 rAF 间隔中位 52.7ms、观测最大 64.2ms，相当于一次渲染被推迟 3–4 帧；
  对照同规模的 C2 只有 16.9ms（正常 60fps）。因此 N=300 时的体验是「可感知的掉帧 / 轻微迟滞」，还没有到一次性 100ms 级卡死。
- N=500：墙钟中位 135.6ms；阻塞中位 82ms、观测最大 84ms、5 次里 4 次出现、≥100ms 0 段；最长帧间隔中位 95.9ms、观测最大 97.8ms（≈6 帧）—— 阻塞随源数近似线性增长。
- **波动必须写进结论**：A 的长任务是「偶发」的（N=300 五次重复逐次结果是 51ms / 52ms / 0ms / 0ms / 0ms，所以中位数才落到 0ms），取决于 IDB 回调批次与 `createObjectURL` 循环是否落在同一个任务里；只看中位数会低估，只看单次最差值又会高估。

### 8.2 场景 B / B2 在主线程上省了多少？
- N=100：A 的阻塞观测最大 0ms → B 0ms（—）/ B2 0ms（—）；墙钟中位 A 27.6ms → B 194.2ms / B2 3.8ms。
- N=300：A 的阻塞观测最大 52ms → B 0ms（少 100%）/ B2 0ms（少 100%）；墙钟中位 A 82ms → B 617.5ms / B2 10.1ms。
- N=500：A 的阻塞观测最大 84ms → B 0ms（少 100%）/ B2 0ms（少 100%）；墙钟中位 A 135.6ms → B 1042.1ms / B2 18ms。

- 这里的「阻塞」按多次重复中的**观测最大值**比较：A 的长任务是偶发的，用中位数会掩盖差异（B/B2 在各 N、各次重复里都是 0ms）。
- B 的代价在墙钟：分帧把工作摊到 38+ 帧（N=300），每批等一帧，端到端被拉长（N=300：617.5ms vs A 82ms）。
- B2 是最便宜的下界：一次 `allDocs` 就够，N=300 墙钟仅 10.1ms、阻塞 0ms；图标先显示远程 URL，本地 blob 留到空闲/可见时再补。

### 8.3 场景 C 能把主线程阻塞降到什么程度？C1 还是 C2？
- N=100：A 阻塞观测最大 0ms → C1 0ms（—）/ C2 0ms（—）；端到端墙钟 A 27.6ms / C1 31.7ms / C2 28.1ms；worker 内部耗时 C1 16.8ms / C2 27.6ms。
- N=300：A 阻塞观测最大 52ms → C1 0ms（少 100%）/ C2 0ms（少 100%）；端到端墙钟 A 82ms / C1 93.2ms / C2 77.6ms；worker 内部耗时 C1 51.5ms / C2 77.3ms。
- N=500：A 阻塞观测最大 84ms → C1 71ms（少 15%）/ C2 0ms（少 100%）；端到端墙钟 A 135.6ms / C1 154.5ms / C2 130.7ms；worker 内部耗时 C1 85.4ms / C2 130.2ms。

- 主线程侧的后处理成本（N=500，差异才看得出来）：C1 67.9ms（N 次 `createObjectURL` + Blob 反序列化），C2 0ms（只处理字符串数组）；收到结果的耗时 C1 86ms / C2 130.7ms。
- C1 vs C2 的主线程阻塞（N=500）：C1 观测最大 71ms / 最长一段 71ms（各次重复的区间 66–71ms），C2 两者都是 0ms；C1 的阻塞量级与它的主线程后处理（67.9ms）一致 —— 因为主线程要先反序列化 N 个 Blob、再连续调 N 次 `createObjectURL`，这一步在大 N 下自己就构成一个长任务。
- **C2 更优**：把 `createObjectURL` 留在 worker，主线程既不接收 N 个 Blob、也不做 N 次 URL 注册，阻塞与后处理时间都趋近于 0（N=300 时两者都是 0，N=500 时 C1 已有 66–71ms 的长任务而 C2 仍为 0）。
- worker 侧的代价：C2 把 500 次 `createObjectURL` 也搬进 worker，worker 内部耗时从 C1 的 85.4ms 涨到 130.2ms，但端到端墙钟反而更短（154.5ms → 130.7ms），因为主线程不再被 N 个 Blob 的反序列化与 URL 注册阻塞。
- 克隆/序列化开销是否划算：20KB 载荷 500 次往返的实测（第 6 节）——Blob 单次往返 47µs、ArrayBuffer 复制 66.6µs、URL 字符串 34.6µs，每次往返都在几十微秒量级。而 C 场景相对 A 省下的是 84ms 量级的主线程阻塞（N=500 观测最大）；每次 postMessage 几十微秒的开销完全可以忽略，**搬运是划算的**。

### 8.4 worker 创建的 blob URL 能不能在主线程显示？
- N=100：能。worker 存活时主线程 `<img>` 加载 worker 创建的 URL —— 5/5 次 decode 成功，naturalWidth/Height = 84x84；`terminate()` 之后同一 URL 仍可加载 —— 5/5 次 decode 成功，naturalWidth/Height = 84x84。
- N=300：能。worker 存活时主线程 `<img>` 加载 worker 创建的 URL —— 5/5 次 decode 成功，naturalWidth/Height = 84x84；`terminate()` 之后同一 URL 仍可加载 —— 5/5 次 decode 成功，naturalWidth/Height = 84x84。
- N=500：能。worker 存活时主线程 `<img>` 加载 worker 创建的 URL —— 5/5 次 decode 成功，naturalWidth/Height = 84x84；`terminate()` 之后同一 URL 仍可加载 —— 5/5 次 decode 成功，naturalWidth/Height = 84x84。
- 原因：blob URL 是按 origin 注册的，不绑定创建它的线程；只要不 `revokeObjectURL`，主线程/其它 worker 都能用。
- 实践含义：C2 不用把 Blob 搬回主线程，直接回传 URL 字符串即可；但要注意 URL 的回收也必须在创建方（worker）做，否则会泄漏——C2 需要一个生命周期管理约定（页面卸载或图标更新时通知 worker revoke）。

### 8.5 反直觉 / 值得注意的结果

1. **墙钟耗时 ≠ 主线程被占用**：场景 A 在 N=300 的墙钟中位 82ms，而 >50ms 的长任务只在 5 次里出现 2 次（最长一段 52ms）。
   原因是 IndexedDB 的读取由浏览器 IO 线程执行，主线程只负责回调与 `createObjectURL`，大部分墙钟时间主线程其实是空闲的；把「墙钟 = 主线程被占用」当成同一件事会严重高估卡顿风险（真正可感知的是长任务与帧间隔）。
2. **真正的单位成本在 `createObjectURL`（约 148.5µs/次，N=300 ≈ 45ms）**，而不是 IDB 读取（0.2–0.3ms/次，且多数时间在等 IO）。
   这也是 C2 相对 C1 唯一实质性的差异点。
3. **Blob 的 postMessage 克隆几乎不要钱**：20KB Blob 单次往返 47µs，与只传 60B 字符串的 34.6µs 同一量级，
   反而比 ArrayBuffer 真实拷贝（66.6µs）更便宜——Chromium 对 Blob 做的是底层数据的引用共享；
   Transferable 零拷贝（62.8µs）也没比拷贝更快，20KB 的拷贝成本低于一次跨线程调度本身。
4. **场景 B 比 A 慢是正常的**：B 为了分帧主动等待 38+ 帧，端到端墙钟 617.5ms > A 82ms，
   但它换来的是把工作摊平；「B 墙钟更差」不等于 B 更差，两者优化目标不同。
5. **`long-animation-frame` 在 headless Chromium 里完全不产生条目**（见第 1 节），如果只依赖它做度量会得到全零结果；
   同理，`PerformanceObserver.takeRecords()` 取早一刻，`longtask` 也会全零——度量口径本身需要阳性对照。

### 8.6 落地建议
- **如果同步后偶发卡顿**：先上 B2 + 空闲补偿（一次 `allDocs` 拿元信息先用远程 URL 渲染，`requestIdleCallback` 里再按批把本地 blob 换上去）——改动最小、收益最大，且不需要 Worker。
- **如果要求「本地 blob 图标优先」且不想让列表渲染等待**：用 C2（Worker 里读附件 + `createObjectURL`，只回传 URL 字符串），把整条链路从主线程搬走；注意 blob URL 的生命周期/回收要由 worker 负责。
- **C1 的意义**：适合「主线程需要 Blob 本身」（例如要解码、做色彩提取）的场景；单纯为了 `<img src>` 的话 C2 更省。
- 无论选哪种，都建议保留 `_rev` 缓存（现有 `feedIconBlobs` 已按 rev 失效），避免每次刷新都重建 N 个 blob URL。

## 9. 方法与局限

- 所有场景共用 `bench-shared.js` 里同一份业务逻辑（`listSubscriptions` / `resolveFeedImage` / `getFeedImageUrl` / `loadIconsParallel`），Worker 场景与主线程场景的差异只在「在哪个线程执行」，对比公平。
- 场景 A 忠实复刻 `loadFeeds()`：先 `allDocs` 订阅列表，再对每个源 `Promise.all` 并发 `get` + `getAttachment` + `createObjectURL` + 远程 URL 回退。
- 场景 B：一次 `allDocs({include_docs:true, keys})` 取全部 FeedDoc（实测附件只带 stub，仍必须逐个 `getAttachment`），附件读取与 `createObjectURL` 按 8 个一批、批间 `await requestAnimationFrame` 分帧。
- 场景 B2：只做一次 `allDocs` 取文档元信息，图标先用文档里的远程 URL 占位，完全不碰附件（「延迟加载图标」的成本下界）。
- 场景 C：worker 内先按同一份种子逻辑建库写数据（写入阶段不计时），再接受主线程的 `load` 指令；端到端墙钟从主线程 `postMessage` 起算到主线程处理完结果为止。
- 指标：主线程阻塞 = `longtask` 时长之和 / 最长值 / ≥100ms 段数；rAF 与 timer 间隔作为交叉口径（>50ms 计为一次停顿）。
- 不含 Vue 响应式赋值与 300 个菜单项重渲染的开销，也不含真实项目里的 CouchDB 同步流量与 AVIF 解码；本基准只覆盖「数据层 + blob URL 创建」。
- 附件用有效 PNG（而非真实项目的 AVIF）是为了让 C2 能用真实 `<img>` 验证解码；两者都是同量级二进制 Blob，对 `getAttachment` / `createObjectURL` 无实质差别。
- 数据在每次测量前新写入同一浏览器会话，IndexedDB 处于「热」状态（与用户首次进入页面后同步完成再读图标的场景一致）；冷启动（进程重启 + 磁盘冷缓存）会让墙钟变长，但主线程阻塞形态不变（异步 IO 本来就不占主线程）。
- worker 场景没有覆盖「worker 内也要同步 CouchDB」的情况——那属于另一个量级的验证。
- 运行期间工作机为 4 vCPU 且可能有其它并发负载，绝对耗时会偏保守；探针（第 2 节）是单次采样，其中 `createObjectURL` 数值本身是 2000 次调用的平均，两次独立运行的观测值为 134.8 / 148.5 µs/次（约 ±10%），结论不受影响。

## 10. 复现方式

- 全量（本报告）：`BENCH_N=100,300,500 BENCH_REPS=5 BENCH_MESSAGING_REPS=3 node report/worker-pouch-bench/bench.mjs --report`
- 快速 smoke：`BENCH_N=100 BENCH_REPS=1 BENCH_MESSAGING_REPS=1 node report/worker-pouch-bench/bench.mjs`
- 只按现有 `raw.json` 重渲染报告（改文案不用重跑浏览器）：`node report/worker-pouch-bench/bench.mjs --report-only`
- 度量口径能力对照（headless shell vs 完整 Chromium）：`node report/worker-pouch-bench/bench.mjs --check-longtask`
- 脚本自带环境自举（`PLAYWRIGHT_BROWSERS_PATH` / `LD_LIBRARY_PATH` / `FONTCONFIG_FILE`，逻辑复制自 `packages/nuxt-client/scripts/verify-lightbox.mjs`），并把 `/pouchdb.js` 与页面资源用本地 `http://127.0.0.1:8899` 静态服务器提供，避免 `file://` 下 IndexedDB / Worker 的限制。
