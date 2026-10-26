import fs from 'node:fs'
import path from 'node:path'
import { test as base, expect, chromium, type BrowserContext, type Page } from 'playwright/test'
import { REPO_ROOT, preparePlaywrightEnv } from './support/playwright-env.mjs'

preparePlaywrightEnv()

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
/** 持久化 profile：登录态 + 本地 PouchDB 都在里面，第二次之后省掉一次全量同步 */
export const PROFILE_DIR
  = process.env.E2E_PROFILE_DIR ?? path.join(REPO_ROOT, 'packages/nuxt-client/.cache/e2e-profile')
export const SHOT_DIR = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/entry-reveal')

interface WorkerFixtures {
  /** 持久化浏览器上下文（worker 级：整个 worker 复用一个 profile） */
  e2eContext: BrowserContext
  /** 应用页面：所有用例共用这一页，串行执行（见 playwright.config.ts 的 workers: 1） */
  appPage: Page
  /** 应用自己（:3000）产生的 JS 运行时错误，最后一条用例统一断言 */
  jsErrors: string[]
}

interface TestFixtures {
  /** 自动 fixture：逐用例开启 trace，失败时作为附件写进报告 */
  traceOnFailure: undefined
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture 第一个参数是依赖声明，这里没有依赖
  jsErrors: [async ({}, use) => {
    const errors: string[] = []
    await use(errors)
  }, { scope: 'worker' }],

  // eslint-disable-next-line no-empty-pattern -- 同上，不依赖其它 fixture
  e2eContext: [async ({}, use) => {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      headless: process.env.HEADED !== '1'
    })
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  appPage: [async ({ e2eContext, jsErrors }, use) => {
    const page = e2eContext.pages()[0] ?? await e2eContext.newPage()
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() !== 'error' || text.startsWith('Failed to load resource')) return
      // 只看应用自己（:3000）发出来的：正文里嵌的第三方 iframe 会把它们自己的
      // console 一并带进来，那不是要盯的东西
      const from = message.location()?.url ?? ''
      if (from && !from.startsWith(BASE)) return
      jsErrors.push(text.slice(0, 300))
    })
    page.on('pageerror', error => jsErrors.push(`pageerror: ${String(error).slice(0, 300)}`))
    // 给所有动作 / 导航一个默认上限：默认 30s 再叠上重试，一次卡顿就能吃掉整个用例超时，
    // 失败信息还只剩「timeout」。e2e 里动作要么秒完成，要么就是页面状态不对。
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(20_000)
    await use(page)
  }, { scope: 'worker' }],

  // 逐用例 trace：持久化 context 不能用 Playwright 自带的 trace 选项，这里手动开关。
  // 只有失败时才留文件，避免通过用例也攒一堆 zip。
  traceOnFailure: [async ({ e2eContext }, use, testInfo) => {
    await e2eContext.tracing.start({ screenshots: true, snapshots: true, sources: true })
    await use()
    if (testInfo.status !== testInfo.expectedStatus) {
      const file = testInfo.outputPath('trace.zip')
      await e2eContext.tracing.stop({ path: file })
      await testInfo.attach('trace', { path: file, contentType: 'application/zip' })
    } else {
      await e2eContext.tracing.stop()
    }
  }, { auto: true }]
})

export { expect }

/** 截图落到 report/entry-reveal（gitignore），沿用老脚本的产物位置 */
export async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}
