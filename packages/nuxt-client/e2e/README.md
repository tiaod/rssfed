# 端到端与真栈集成测试

两类测试，都打真的 dev 栈，不在默认 `pnpm test` 里（CI 没有服务依赖）：

| 目录 / 命令 | 运行器 | 测什么 |
|---|---|---|
| `e2e/` · `pnpm --filter @rssfed/nuxt-client test:e2e` | Playwright Test（浏览器） | 真 Chromium + 真前端 + 真后端 + 真本地库的交互 |
| `integration/` · `pnpm --filter @rssfed/nuxt-client test:integration` | vitest（node） | 真 Hono + 真 CouchDB + 真 PouchDB 的服务端聚合/同步链路 |

单测（`app/__tests__/`，vitest + happy-dom）负责逻辑；**单测能钉住的行为不要往这里搬**。

## 前置

- 依赖已装：浏览器运行器随根目录的 `playwright` 包提供（1.63 起自带 `playwright/test`，不用另装
  `@playwright/test`）。
- dev 栈在跑：前端 `:3000`、后端 `:3001`、CouchDB `:5984`（`pnpm dev:all` 或仓库里的 compose）。
- admin 账号可登录（`admin@example.com` / `Admin123!`）。
- 浏览器：容器里没有系统 Chromium/中文字体，`e2e/support/playwright-env.mjs` 会自动接好
  项目内的浏览器目录（`node_modules/.playwright-browsers`）、缺的 `.so`
  （`node_modules/.pw-syslibs`）与中文字体（`node_modules/.pw-fonts`）。
  浏览器没装时：
  ```bash
  PLAYWRIGHT_BROWSERS_PATH=<repo>/node_modules/.playwright-browsers \
  PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
    pnpm exec playwright install chromium
  ```
  （国内直连 Playwright 官方 CDN 很慢，镜像二三十秒。）

## 跑

```bash
pnpm --filter @rssfed/nuxt-client test:e2e          # 浏览器 e2e
pnpm --filter @rssfed/nuxt-client test:e2e:ui       # 交互式调试
HEADED=1 pnpm --filter @rssfed/nuxt-client test:e2e # 看着浏览器跑
pnpm --filter @rssfed/nuxt-client test:integration  # 真栈集成（约 20–30s）
```

单独跑某个文件：

```bash
cd packages/nuxt-client
pnpm exec playwright test e2e/entry-reveal.spec.ts
pnpm exec vitest run --config vitest.integration.config.ts
```

产物（`report/` 被 gitignore，只在本机）：

- `report/playwright/html/`：HTML 报告（`pnpm exec playwright show-report` 打开）
- `report/playwright/test-results/`：失败用例的 `trace.zip`（`pnpm exec playwright show-trace <zip>`）
- `report/entry-reveal/`、`report/entry-images/`、`report/lightbox/`：用例里的关键截图与证据 JSON

## 持久化 profile 与数据

- 浏览器用例的登录态与本地 PouchDB 都在 `packages/nuxt-client/.cache/e2e-profile`
  （可用 `E2E_PROFILE_DIR` 覆盖）。**首次运行是冷的**：要等首屏全量同步（实测 377.9MB / 2784 条，
  约 2 分钟），之后复用同一个 profile，整套用例约 3–4 分钟。
- 所以 `workers` 必须是 1、用例串行执行：两个 Chromium 不能同时用同一个 `userDataDir`，
  admin 账号也只有一份。
- 需要重置数据时删掉 `.cache/e2e-profile` 即可（下次运行会自动重新登录 + 同步）。
- 集成测试自己注册临时账号、写探针条目并清理；它和旧脚本共用固定探针 URL，**不要并发跑两份**。

## 约定

- e2e 代码必须放在被 git 跟踪的目录：Playwright 会跳过 `.gitignore` 里的目录，
  `report/` 下的 spec 不会被发现。
- 用例间共享同一个页面（省一次登录 + 同步）：每个用例显式把页面复位到需要的状态
  （`resetToList()`、切色彩模式、切视图）。
- 断言用 `expect`；「一次运行拿到完整失败清单」的检查用 `expect.soft`。
- e2e 只重放交互/状态流转，不重跑单测已经钉住的纯逻辑。

## 文件

```
e2e/
  fixtures.ts            # 持久化 context、登录、逐用例 trace、JS 错误收集、默认超时
  support/timeline.ts    # 登录/等列表/切视图/滚动采样等公共操作
  support/playwright-env.mjs  # 容器里的浏览器/系统库/中文字体自举（config 里调用）
  entry-reveal.spec.ts   # 关详情后滚回刚读的那条 + 闪一下（三种展示面）
  entry-route.spec.ts    # /rss/feed/:id/entry/:entryId 地址语义、深链、返回、切源残留
  entry-images.spec.ts   # 正文图先占位再换 blob、零源站请求、图上屏
  lightbox.spec.ts       # 点击放大、滚轮缩放、嵌套模态、暗色
  smoke.spec.ts          # 登录 + 列表渲染的环境冒烟
integration/
  timeline-sync.test.ts  # 服务端聚合 + 客户端单库双向同步（真栈，11 组性质）
```

迁移自旧的 `scripts/verify-*.mjs`（已删除）；旧脚本的 `pnpm verify:*` 入口也一并移除。
