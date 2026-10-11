# 侧边栏加载性能：真实规模实测（626 个订阅源）

> **留档说明**：本文原为 `report/sidebar-perf/RESULTS.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。

数据环境：admin 账号 **626 个订阅源**，本机容器 4 vCPU，Chromium 153（headless），
CouchDB 3.5 本地。前端分别测了 **dev server** 与 **生产构建**（`nuxt build` + Nitro server）。

脚本（都在本目录，可复跑）：

| 脚本 | 作用 |
| --- | --- |
| `measure-perf.mjs` | dev 模式：cold/warm 两轮 + CPU profile |
| `isolate.mjs` | dev 模式：整块隐藏 UI 做排除法 |
| `measure-prod.mjs` | 生产构建：cold/warm + CPU profile（自带 CORS 转发，因为后端白名单只含 :3000） |
| `isolate-prod.mjs` | 生产构建：整块隐藏 UI 做排除法 |

---

## 1. 主表：dev vs 生产（同一份数据、同一台机器）

| 环境 | 侧边栏首次出现 | 侧边栏稳定 | 最长单次主线程阻塞 | 阻塞总计 |
| --- | --- | --- | --- | --- |
| dev + Nuxt DevTools | 1689ms | 3228ms | **799–912ms** | 981–1155ms |
| dev（临时关掉 DevTools） | — | — | **673ms** | 736ms |
| **生产构建（冷启动）** | **553ms** | 2120ms | **429ms** | 510ms |
| **生产构建（热启动）** | **608ms** | 2552ms | **451ms** | 553ms |

**结论 1：dev 模式下的数字会把问题放大 2 倍左右。** 「卡几秒」的感受里有很大一部分是 dev 环境：
Nuxt DevTools 的 overlay/检查器（每次导航 ~100–230ms）+ Vite dev 的模块系统 + 未压缩未优化的 Vue。
**性能自测请用生产构建**，否则会去优化并不存在的问题。

## 2. 排除法：那 ~400ms 到底来自哪一块 UI

生产构建、热态，用早注入的 CSS 整块隐藏后测（中位数）：

| 变体 | 最长主线程阻塞 | 阻塞总计 |
| --- | --- | --- |
| 现状 | 412ms | 466ms |
| 隐藏侧边栏（626 项 + 图标） | 427ms | 595ms |
| 隐藏主内容区（时间线卡片 + 封面图） | 396ms | 479ms |
| 两者都隐藏 | 415ms | 415ms |

**结论 2：这 ~400ms 与我们的 UI 渲染无关。** 全部隐藏后阻塞量级不变。
（同样的实验在 dev 下结论一致：隐藏全部也是 ~800ms。）

## 3. CPU profile 归因（生产热态，采样窗口 5.77s）

| 项 | 耗时 | 说明 |
| --- | --- | --- |
| `(idle)` | 3168ms (55%) | 空闲 |
| `(program)` | 1071ms (18.6%) | 浏览器原生工作（解码/样式/布局等，无法归因到 JS 函数） |
| `(garbage collector)` | 147ms | GC |
| `put` + `get` + `transaction` + `blob` + `slice` | **≈ 303ms** | **PouchDB 往 IndexedDB 落库（同步）** |
| `fetch` | 116ms | 网络 |
| Vue 相关（`mergeProps`/`createReactiveObject`/`emit`/`track`…） | **≈ 120–150ms** | 组件创建与响应式 |

**结论 3：可归因的 JS 成本里，PouchDB 同步落库（~300ms）比侧边栏渲染（~120–150ms）更大。**
侧边栏 626 项的成本真实存在，但不是「几秒」的来源。

## 4. 几种「减少渲染」的手段实测无效

在 dev 下对 626 项逐一试验（注入 CSS）：

| 手段 | 最长阻塞 | 说明 |
| --- | --- | --- |
| 现状 | 909ms | — |
| `content-visibility: auto`（跳过视口外布局） | 811ms | 无明显收益 |
| `content-visibility: auto`（含子列表） | 818ms | 无明显收益 |
| CSS 隐藏第 60 项之后 | 755ms | **只减少布局/绘制，DOM 仍被创建** |
| 两者叠加 | 793ms | 无明显收益 |

**结论 4：靠 CSS 省不掉成本 —— Vue 仍然会创建这些组件与 DOM。**
要真正省下来必须**不渲染**它们（默认折叠分组 / 虚拟列表），而不是隐藏。

## 5. 推荐动作（按性价比）

1. **性能自测改用生产构建**：`pnpm --filter @rssfed/nuxt-client build` 后 `node .output/server/index.mjs`。
   dev 下的 800–900ms 在生产是 400ms 量级，先别对着 dev 数字做决策。
2. **给 feed 图标单独定尺寸**（后端 1 行 + 缓存失效）：`packages/hono-server/src/rss/entry-images.ts` 的
   `cacheSingleImage()` → `compressToAvif(raw, { maxWidth: 64 })`。
   这是全链路里**唯一能造成秒级阻塞**的单点：实测 300 张 1200px AVIF 解码会阻塞主线程 1.0–5.3 秒
   （而 190px / 64px 均为 0–15ms）。626 个源里只要有几个大 logo 就会命中。
3. **削同步峰值**：`usePouchDb.ts` 的 `MAX_CONCURRENT_REPLICATE = 3` → 1~2。
   profile 里 ~300ms 来自同步落库，降低并发能把这段阻塞摊平（总时长会变长，但峰值更低）。
4. **侧边栏真减少渲染项**：`useFeedNavigation.ts` 里分组是 `defaultOpen: true`（626 项全渲染）。
   改成「只展开当前路由所在分组」或默认折叠，可省掉 ~100–150ms 的组件创建；
   注意必须是**不渲染**（折叠 → children 不进 DOM），CSS 隐藏无效（见第 4 节）。
5. **DevTools 按需开**：dev 下每次导航省 ~100–230ms。
6. **Worker 化（最初的想法）**：能把 put/get/md5/slice 这 ~300ms 移出主线程，
   方向正确但改造大；建议先做 2–4，再看是否还需要。

## 6. 方法学备忘

- **长任务口径**：`PerformanceObserver({entryTypes:['longtask']})` + rAF 间隔 + 10ms 心跳三重采样；
  本环境 headless 下 longtask 可用（此前一次口径失效的结论已由阳性对照推翻，见
  `./pouchdb-sidebar-icon-bench.md` 第 0 节）。
- **生产环境测量绕不开 CORS**：后端 `CORS_ORIGINS` 只允许 :3000，而生产 server 起在 :3010
  （:3000 被 dev server 占用）。`measure-prod.mjs` 用 Playwright route 转发：请求补
  `Origin: http://localhost:3000`，响应把 `Access-Control-Allow-Origin` 改回 :3010。
- **生产构建下登录页不再预填测试账号**（`import.meta.dev` 为 false），脚本需显式填邮箱密码。
- dev 测量还有一个坑：`/timeline` 的未登录拦截是客户端中间件做的，且中间件在会话请求出错时
  会放行（`app/middleware/auth.ts`），所以「访问 /timeline 看有没有被重定向到 /login」不能
  用来判断登录态，否则整轮测量会在未登录状态下跑完（侧边栏 0 项）。

---

## 7. 优化实施与复测

按第 5 节的建议实施了 4 项（均在本次改动内）：

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| feed 图标压到 64px | `hono-server/src/rss/entry-images.ts` | 新增 `FEED_ICON_MAX_WIDTH`（默认 64）+ `FEED_ICON_CACHE_VERSION`；图标不再继承正文图片的 1200px 上限 |
| 图标缓存版本化失效 | `entry-images.ts` + `workers/index.ts` + `db/types.ts` | `CachedImage.v`；worker 在 `imageCached.v !== 当前版本` 时重压（附件名固定，光比 URL 发现不了参数变化） |
| 存量图标重建脚本 | `hono-server/scripts/rebuild-feed-icons.ts` | 幂等、支持 `--dry-run`；本次实跑：25 个图标重建，**76KB → 17KB**（源图有 640/540/500/268px 的） |
| 分组默认折叠 | `nuxt-client/.../useFeedNavigation.ts` + `FeedNavigation.vue` | 只展开当前路由所在分组，受控 `v-model` 维护展开状态；路由变化时并入新分组 |
| 复制并发 3 → 2 | `nuxt-client/.../usePouchDb.ts` | 削同步落库的主线程峰值 |

### 复测（生产构建、热态、同一账号与数据）

| 指标 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 侧边栏渲染菜单项 | 626 | **19** | −97% |
| 侧边栏首次出现 | 608ms | **78ms** | 7.8× |
| 侧边栏稳定 | 2552ms | 2089ms | −18% |
| **最长单次主线程阻塞** | **451ms** | **55ms** | **8.2×** |
| 阻塞总计 | 553ms | 105ms | −81% |
| ≥100ms 长任务 | 2 段 | **0 段** | 消除 |
| 最长 rAF 间隔 | 462ms | **64ms** | 7.2× |
| CPU `(program)`（原生） | 1071ms | 182ms | −83% |
| CPU 空闲占比 | 55% | 91.7% | — |

冷态（首次进入、本地库为空）同样改善：阻塞总计 510ms → **137ms**，最长 429ms → **71ms**。

### 代价：展开大分组时的一次性成本

默认折叠只是把渲染成本推迟到用户主动展开时。实测逐组展开（生产构建）：

| 分组规模 | 展开后菜单项 | 展开时的长任务 |
| --- | --- | --- |
| +2 ~ +39 项（6 组） | 21–58 | 无 |
| +64 ~ +92 项（3 组） | 83–111 | 59–93ms |
| **+140 项（最大组）** | 159 | **104ms** |

即：小分组展开无感；超大分组展开有一次约 60–105ms 的抖动（掉 4–6 帧），但这是用户主动触发的一次性成本，
相比改前「每次打开页面固定 451ms」是净收益。若后续仍嫌大，可在分组内做虚拟列表或分页。

### 路由联动校验

- `/timeline`（不属于任何分组）→ 菜单项 19，图标位 0（全折叠）；
- `/rss/group/二次元%20%26%20视频` → 菜单项 22、图标位 3 → 该分组默认展开 ✅。

### 验证

- 前端 126 单测、后端 66 单测全通过（新增：菜单折叠/路由联动 2 例、图标 64px 上限 1 例）
- 两端 `typecheck` 通过、`eslint` 零问题
- 生产构建复测（`measure-prod.mjs`）+ 折叠校验（`verify-collapse-prod.mjs`）
