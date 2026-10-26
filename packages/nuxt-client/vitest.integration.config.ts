import { defineConfig } from 'vitest/config'

/**
 * 真栈集成测试的独立配置（与 `vitest.config.ts` 的单测配置互不影响）。
 *
 * 这批测试打的是**真的本地 dev 栈**（Hono :3001 + CouchDB :5984 + Node 里的真 PouchDB），
 * 不走 happy-dom、不 mock 任何服务端对象，所以：
 *
 * - `environment: 'node'`：要用真的 PouchDB（leveldb 适配器）写本地库；
 * - 不加载 `app/__tests__/setup.ts`（那是单测的 DOM/全局 stub）；
 * - 超时给足：整套流程串行约 40–60s，但 dev 机上可能同时跑着浏览器 e2e/构建，
 *   按单条断言超时算会误报，所以放宽到 5 分钟；
 * - `fileParallelism: false`：集成测试共享 dev 栈与那条**固定地址**的探针源库，
 *   并发跑会互相删对方的探针条目。
 *
 * 跑法（在 packages/nuxt-client 下）：
 *   pnpm exec vitest run --config vitest.integration.config.ts
 *
 * 前置：dev 栈在跑（前端 :3000 用于 Origin/CSRF、后端 :3001、CouchDB :5984 admin/admin）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    // 整套 40–60s；给足余量吸收 dev 机上的并发负载
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // 串行执行：多个集成测试文件/用例会抢同一个探针源库与 dev 栈
    fileParallelism: false,
    sequence: { concurrent: false },
    // 集成测试的 ✓/✗ 进度日志是排查线索，不要被 vitest 的 console 拦截藏起来
    disableConsoleIntercept: true
  }
})
