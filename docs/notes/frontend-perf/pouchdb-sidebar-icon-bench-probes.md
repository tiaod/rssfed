# 补充实测与合并结论（PouchDB 侧边栏卡顿归因）

> **留档说明**：本文原为 `report/worker-pouch-bench/RESULTS-probes.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。
> 文中的 `RESULTS.md` 指同目录的 [`pouchdb-sidebar-icon-bench.md`](./pouchdb-sidebar-icon-bench.md)。

本文件补充 `RESULTS.md`（子代理基准）之外的三组探针数据，并给出三份数据的合并结论。
`RESULTS.md` 保持为可复现的原始基准报告（`node bench.mjs --report-only` 可重新渲染）。

数据来源：

| 来源 | 口径 | 测什么 |
| --- | --- | --- |
| `RESULTS.md` / `raw.json` | `longtask` + rAF + timer 四口径（已做阳/阴对照） | 侧边栏链路 A/B/B2/C1/C2，N=100/300/500 × 5 次 |
| `probe-blocking.mjs` / `.json` | `setTimeout(10)` 心跳间隔（已做阳/阴对照） | PouchDB 全量复制与首次建索引的主线程占用 |
| `probe-render.mjs` / `.json` | 同上 | 300 张图标在不同源尺寸下的解码阻塞 |
| `probe-render-vue.mjs` / `.json` | 同上 | Vue 渲染 300 个近似 `UNavigationMenu` 菜单项 |
| `../worker-bundle-check/` | `vite build` 产物分析 | pouchdb 能否打进 module worker |

> 口径交叉验证：本文件的 timer 心跳口径与 `RESULTS.md` 的 timer 口径一致；
> `RESULTS.md` 的阳性对照（忙等 200ms）被 longtask/rAF/timer 三口径同时检出，
> 本文件的阳性对照同样检出（`maxGapMs = 200.1`）。两套测量可互相印证。

---

## 1. PouchDB 数据层：复制与建索引几乎不占主线程

本地 CouchDB 3.5 作远端，3000 条 entry（每条 ~2KB 正文，共 ~6MB），
经同源反代让浏览器走真实 PouchDB http adapter + `replicate.from`（非合成 bulkDocs）。

| 场景 | 最长主线程停顿 | 阻塞总时长 | 心跳中位间隔 | 备注 |
| --- | --- | --- | --- | --- |
| 校准：忙等 200ms（阳性） | 200.1ms | 190.1ms | — | 口径有效 |
| 校准：空闲 300ms（阴性） | 0ms | 0ms | 10.0ms | 无假阳性 |
| **主线程**全量复制 3000 条 | **0ms** | **0ms** | 10.0ms | 92 次心跳，`docs=3001` |
| Worker 内全量复制 3000 条 | 0ms | 0ms | — | worker 内耗时 918ms |
| **主线程**首次 `db.query` 建 map view 索引 | **12.8ms** | 2.8ms | 10.0ms | 49 次心跳，无 >50ms 停顿 |
| Worker 内首次建索引 | 0ms | 0ms | — | worker 内耗时 507ms |

与 `RESULTS.md` 的结论一致（那里也测到 `get` 0.2ms / `getAttachment` 0.3ms）。
**PouchDB 的复制写入与索引构建不是侧边栏卡顿的来源**；把这两个环节搬进 worker 的收益上限是每批十几毫秒。

> 局限：单机 Chromium、4 vCPU 容器、本地 CouchDB（无网络延迟）、单条 2KB。
> 3 万条量级按线性外推仍是百毫秒级；**旧设备 / 移动端 Safari 未测**，那里 IndexedDB 实现不同。

## 2. 图标解码：只有在「源图标很大」时才是秒级杀手

后端 `packages/hono-server/src/rss/entry-images.ts` 的 `cacheSingleImage()` 调
`compressToAvif(raw)` **未传 `maxWidth`** → 取默认 `DEFAULT_MAX_IMAGE_WIDTH = 1200`、`DEFAULT_AVIF_QUALITY = 45`。
侧边栏 avatar 只显示约 32px。用 sharp 按同参数生成图标，页面加载 300 个 32×32 `<img>`：

| 图标源尺寸（AVIF q45） | 加载 300 张总耗时（中位） | 最长主线程停顿（中位 / 最大） | 阻塞总时长 |
| --- | --- | --- | --- |
| **1200px（后端默认上限）** | **1033–5259ms** | **1032–4804ms / 5246ms** | **1022–5236ms** |
| 512px | 13.1–13.9ms | 0ms / 399ms | 0ms |
| 256px | 14.3–16.3ms | 0–12.2ms / 25.4ms | 0–2.2ms |
| **190px（开发库实测的真实 favicon 尺寸）** | **13.8ms** | **0ms / 14.7ms** | **0ms** |
| 64px（按显示尺寸出图） | 19.9ms | 13.5ms / 20.1ms | 3.5ms |
| 1200px **PNG**（隔离解码器因素） | 14.3–17.4ms | 0ms / 177ms | 0ms |

要点：
- 1200px AVIF 稳定复现**秒级**主线程阻塞；同尺寸 PNG 完全不卡 → 瓶颈在 AVIF 解码路径，
  且是超线性的（≤512px 基本无阻塞，1200px 直接爆）。
- CSS 把 `<img>` 限成 32px **不减少解码量**，解码按源图像素数进行。
- 真实 feed 图标尺寸：扫描本地 CouchDB 的 16 个 `feed_*` 库，3 个带尺寸信息的是 32 / 180 / 190px
  （`compressToAvif` 的 `withoutEnlargement: true`，源图比 1200 小就按原尺寸出图）。
  **因此这是「放大器 + 防御性修复」**：只要有一个源提供 512px+ 的大 logo，就会在侧边栏造成数百毫秒到数秒的卡顿。

## 3. Vue 菜单渲染：几十毫秒量级

用真实 Vue 3.5.35 生产构建渲染近似 `UNavigationMenu` 的结构
（分组 → 项 → link + avatar + label，两层组件，300 项 / 1501 DOM 节点）：

| 场景 | mount（中位 / 最大） | 数据换新对象后 patch | mount 最长停顿 |
| --- | --- | --- | --- |
| 无图标（纯文字 fallback） | 13.0 / 24.7ms | 31.8ms | 12.8ms |
| 190px AVIF 图标 | 27.5ms | 32.6ms | 23.3ms |
| 1200px AVIF 图标 | 24.1 / 28.6ms | 25.9ms | 22.4ms |

`FeedNavigation.vue` 在 `syncStatuses['__user_state__']` 每次版本变化后都会重新 `loadFeeds()`，
而 `loadFeeds()` 每次都重建 `feeds` / `iconSrcs` 两个新对象 → 整棵菜单 patch 一遍，
后台同步活跃时会周期性重复这 ~30ms 加 N 次文档读取。

> 局限：这是简化结构，真实 `UNavigationMenu` 还有 tooltip/popover 包装与主题类，可能贵 2–5 倍
> （即 100–300ms 量级）；未含真实页面的样式计算与布局。

## 4. Worker 化可行性核查

| 核查项 | 结果 | 证据 |
| --- | --- | --- |
| 纯 PouchDB 能否在 Dedicated Worker 里运行 | **可以** | `pouchdb@9` 的 browser 入口 `lib/index-browser.js` 不引用 `window`，只用全局 `indexedDB`；worker 内建库并复制成功 |
| Vite 7 能否把 `pouchdb` + `pouchdb-find` 打进 module worker | **可以，零 polyfill** | `report/worker-bundle-check/`：`vite build` 产出 `db.worker-*.js` 409KB；产物中无 `leveldown` / `require(` / `process.env` / `typeof window`，含 `indexedDB.open` → 正确解析到 browser 入口 |
| 复制是否跑在 worker 内 | **会** | 调用是 `db.replicate.from(remoteUrl字符串)`，URL 字符串进 worker 后由 worker 建远端 PouchDB，复制全程在 worker 内 |
| worker 内 `createObjectURL` 的 URL 主线程能否用 | **可以** | `RESULTS.md`：真实 `<img>` 解码成功（`naturalWidth=84`，3/3 次），`worker.terminate()` 后仍可用 → 按 origin 注册，不绑定创建线程 |
| worker 内能否用 `localStorage`（`loadSyncedFeeds`/`markSynced` 依赖） | **不能** | `DedicatedWorkerGlobalScope` 无 `localStorage`；需改存 IndexedDB（如 PouchDB 的 `_local/` 文档）或由主线程代管 |
| 官方现成方案 `worker-pouch` | **不建议** | 最后版本 1.1.0（2018）；Easy Mode 依赖 Blob URL worker（Safari 不支持，WebKit bug 149953）；作者自述「在意哪些操作在 worker 内，就别用它，直接在 worker 里跑 PouchDB 自己传消息」 |
| 现有 API 是否便于改造 | **很有利** | `usePouchDb()` 对外 18 个方法全是 async；唯一泄漏 PouchDB 实例的 `getUserStateDb()` 生产代码无外部调用（仅测试用）→ 保持 API 形状换 RPC 代理即可 |
| 改造的确定成本 | 中等偏大 | worker 侧核心（库/复制队列/视图/查询，现 1118 行大部分可搬）+ 主线程 RPC 代理 + 事件通道（`syncStatuses` 改 postMessage 推送）；`useApi`/`useUserStore`/`useCouchTargets` 需把 baseURL / userId / remoteUrl 注入；错误对象跨线程丢自定义字段需显式序列化；`new Worker` 必须 client-only |

## 5. 合并结论

**侧边栏卡顿的成本构成（N=300，桌面 Chromium 热状态）**

| 环节 | 主线程成本 | 来源 |
| --- | --- | --- |
| N 次 `get` + `getAttachment` 回调链 | 小（IDB 读取本身 0.2–0.3ms/次，主线程主要在等） | `RESULTS.md` |
| **N 次 `URL.createObjectURL`** | **≈ 40–45ms（148.5µs/次）← 单位成本大头** | `RESULTS.md` |
| Vue 渲染 300 个菜单项 | 13–33ms | `probe-render-vue` |
| 图标解码（真实 190px） | 0–15ms（但 1200px 时是 1.0–5.3 秒） | `probe-render` |
| **实测合计体验** | N=300 掉 3–4 帧（帧间隔 51–64ms），N=500 掉 ~6 帧（帧间隔中位 96ms，5 次里 4 次出现 80–84ms 长任务） | `RESULTS.md` |

**三条可选路线**

| 路线 | N=300 主线程阻塞 | 墙钟 | 改动量 | 说明 |
| --- | --- | --- | --- | --- |
| A 现状 | 0–52ms（偶发），每次掉 3–4 帧 | 82ms | — | — |
| **B2 一次 allDocs + 远程 URL 占位** | **0ms** | **10.1ms** | 小（纯前端） | 图标先走网络，空闲/可见时再补本地 blob；性价比最高 |
| **C2 Worker（读取 + `createObjectURL` 都在 worker，只回传 URL 字符串）** | **0ms** | 77.6ms | 中大（架构） | 保留「本地 blob 优先、离线可用」体验的唯一方案 |
| B 批量 + 每批 8 个分帧 | 0ms | 617ms | 小 | 把长任务摊成 38+ 帧，端到端被拉长 |

**推荐顺序**

1. **只对可视项做 `createObjectURL`（懒加载图标）+ `loadFeeds()` 增量化**：
   不动后端、不搬 worker，直接把 N 从 300 降到可视的 20–30，`createObjectURL` 与渲染成本随之降一个数量级。
2. **B2**：图标先用 `FeedDoc.image` 的远程 URL 占位，进入可视区/空闲时再读本地附件替换。
3. **图标尺寸治理（防御性，1 行后端改动）**：`cacheSingleImage()` 改为
   `compressToAvif(raw, { maxWidth: 64 })`（或 128 兼顾 hi-DPI），并让已缓存的 `feed-image.avif` 失效重生成。
   否则任何提供大 logo 的源都会造成秒级卡顿。
4. **若确定要把数据层搬进 worker（用户最初的设想，方向正确）**：采用 **C2 形态**（worker 内建库、复制、
   读附件并 `createObjectURL`，只回传 URL 字符串）；**不要用 C1**（回传 Blob 会让主线程反序列化 + 建 URL，
   N=500 时自己制造 66–71ms 长任务）。
5. 顺手删掉 `pouchdb-find`：`usePouchDb.ts` 仍 `PouchDB.plugin(PouchDBFind)`，但全仓已无 `db.find()` 调用。
6. 落地前在真实数据上录一次 DevTools Performance 确认长任务归属（本报告是合成数据 + 桌面 Chromium）。
