import { expect, test } from './fixtures'
import { ensureListView, ensureLoggedIn, SYNC_WAIT_MS, waitForList } from './support/timeline'

/**
 * 骨架冒烟：登录 + 时间线列表渲染。
 *
 * 它的作用不是验证业务，而是确认 Playwright Test 这一层（配置、持久化 profile、登录、
 * 「查看」上屏逻辑、浏览器环境自举）是通的。跑绿之后由业务 spec 接手。
 */
test('登录并渲染时间线列表', async ({ appPage }) => {
  test.setTimeout(SYNC_WAIT_MS + 120_000)
  await ensureLoggedIn(appPage)
  await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
  expect(await waitForList(appPage, SYNC_WAIT_MS), '时间线加载出条目').toBe(true)
  await ensureListView(appPage, '列表')
  await expect(appPage.locator('[data-entry-id]').first()).toBeVisible()
})
