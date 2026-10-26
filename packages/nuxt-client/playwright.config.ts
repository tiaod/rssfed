import path from 'node:path'
import { defineConfig } from 'playwright/test'
import { REPO_ROOT, preparePlaywrightEnv } from './e2e/support/playwright-env.mjs'

/**
 * Playwright Test 配置（端到端）。
 *
 * 与单测（vitest + happy-dom）的分工：这里只跑「真浏览器 + 真后端 + 真本地库」的流程，
 * 单测能钉住的行为不要往这里搬。
 *
 * 为什么直接用根目录的 `playwright` 包：1.63 起测试运行器已随包提供（`playwright/test`），
 * 不需要另外装 `@playwright/test`。
 *
 * 为什么必须在这里调 `preparePlaywrightEnv()`：容器里没有系统浏览器/中文字体，浏览器二进制
 * 与缺的 .so 都在项目内（node_modules/.playwright-browsers、.pw-syslibs、.pw-fonts）。
 * 配置在 worker 进程创建之前加载，这里改的环境变量会被 worker 与它拉起的 Chromium 继承。
 */
preparePlaywrightEnv()

/** 仓库根的 report/ 是 gitignore 的，只放产物，不放测试代码（Playwright 会跳过 gitignore 目录） */
const REPORT_DIR = path.join(REPO_ROOT, 'report/playwright')

export default defineConfig({
  testDir: './e2e',
  // 所有用例共用同一个 admin 账号与同一份本地 PouchDB，不能并行：两个 worker 会抢
  // 同一个持久化 profile（Chromium 的 userDataDir 只允许一个实例）
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(REPORT_DIR, 'html'), open: 'never' }]
  ],
  outputDir: path.join(REPORT_DIR, 'test-results'),
  use: {
    // 优先复用已经在跑的 dev server（前端 :3000、后端 :3001），不在这里另起一套
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    locale: 'zh-CN',
    // 单独跑某一个文件时允许 headed 观察；默认无头
    headless: process.env.HEADED !== '1'
    // 失败现场由 e2e/fixtures.ts 里逐用例的 trace 负责（用的是持久化 context，
    // Playwright 自带的 trace/screenshot 选项对自建 context 不生效）
  }
})
