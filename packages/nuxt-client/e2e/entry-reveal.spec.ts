import type { Page } from 'playwright/test'
import { expect, shot, test } from './fixtures'
import {
  activeTitle,
  clickFirstItem,
  clickFirstTableRow,
  closeAnyDetail,
  ensureEnoughItems,
  ensureListView,
  ensureLoggedIn,
  entryState,
  flashState,
  listState,
  MODAL,
  NEXT_CLICKS,
  PANE,
  pressNext,
  readItemState,
  resetToList,
  scrollListBy,
  scrollListToTop,
  startScrollSampler,
  stopScrollSampler,
  SYNC_WAIT_MS,
  waitForList,
  waitForSyncIdle
} from './support/timeline'

/**
 * 「关掉详情后回到刚才读的那一条」端到端验证（从 scripts/verify-entry-reveal.mjs 迁到
 * Playwright Test）。
 *
 * 场景：连点多次「下一篇」翻了很多篇再关掉详情，列表还停在最初点开的那一条上 ——
 * 不自动滚回去，用户得往下翻很久才找得到自己读到哪儿（宽屏阅读栏则是选中高亮跑到了视口外）。
 * 口径（见 EntryList 的 revealEntry）：
 *   1. 刚读的那条在视口外 → 平滑滚过去并居中，并且**滚到位之后才闪**
 *      （前者靠逐帧采样滚动位置证明，后者靠采样里「闪过的那一帧在最后一次位移之后」证明）；
 *   2. 已经看得见的那条只闪不滚（不推走用户当前的滚动位置）；
 *   3. 闪一下的动画自己退场（约 1.5s），不留成第二个「选中态」；
 *   4. 条目不在当前列表里（换源 / 被「只看未读」筛掉）时什么都不做 —— 由 vitest 覆盖；
 *   5. **没点过上一篇 / 下一篇就关掉（读完直接返回）时，既不滚也不闪** —— 这里跑它的
 *      端到端复核（详情开着时把列表滚走，关掉后位置必须一丝不动）。
 *
 * 两个展示面互斥挂载，都要走一遍：
 *   A. 宽屏（1440×900）+ 列表视图：右侧常驻阅读栏，点 X 关闭后定位；
 *   B. 窄屏（390×844）+ 列表视图：全屏弹窗，按「关闭」后定位；
 *   C. 宽屏（1440×900）+ 表格视图：行由 UTable 生成，标记只能挂 entry-flash 类，
 *      定位走根节点的 scrollTo —— 与 A/B 是两条不同的代码路径，都要走一遍；
 *   D. 宽屏 + 列表视图：点开一篇、不翻篇、关掉 —— 口径 5 的端到端复核。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态与本地 PouchDB 存在
 * playwright.config.ts 指定的持久化 profile 里，第二次之后很快；profile 被清空时要重等
 * 一次首屏全量同步）。用例之间共享同一个页面（串行执行），所以每个用例先复位。
 */
test.describe.configure({ mode: 'serial' })

test.describe('关闭详情后回到刚读的那一条', () => {
  test.beforeAll(async ({ appPage }) => {
    test.setTimeout(SYNC_WAIT_MS + 180_000)
    console.log('[setup] 登录…')
    await ensureLoggedIn(appPage)
    console.log(`[setup] 已登录，url=${appPage.url()}，进入时间线…`)
    await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
    console.log('[setup] 等待列表（冷 profile 要等首屏全量同步）…')
    expect(await waitForList(appPage, SYNC_WAIT_MS), '时间线加载出条目').toBe(true)
    await appPage.waitForTimeout(1_000)

    // 「列表」视图是唯一会在宽屏拉起常驻阅读栏的版式（见 useReaderPaneMode）
    await ensureListView(appPage, '列表')
    await expect(appPage.locator(PANE), '宽屏 + 列表视图：阅读栏常驻').toHaveCount(1)

    // 「下一篇」要翻得够远才有意义：条目太少的话前置条件（刚读的那篇不在视口里）根本不成立。
    // 放在切视图之后：列表视图行高固定 96，渲染条数与「内容有多少屏」都好判。
    const ready = await ensureEnoughItems(appPage, 180_000)
    expect(ready.items, `列表里铺开的条目足够验证翻页（渲染 ${ready.items} 条）`).toBeGreaterThanOrEqual(8)
    expect(
      ready.scrollHeight,
      `内容至少两屏（${ready.scrollHeight}px / 视口 ${ready.clientHeight}px）`
    ).toBeGreaterThanOrEqual(ready.clientHeight * 2)
  })

  test.beforeEach(async ({ appPage }) => {
    // 每个用例都从一次干净的时间线加载开始：UModal 关闭动画/焦点锁/虚拟化残留在
    // 连续用例之间偶尔会把后续点击吞掉（表格按钮点不动就是这么来的），reload 最省事。
    await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
    expect(await waitForList(appPage, 120_000), '时间线重新加载出条目').toBe(true)
    await resetToList(appPage)
    // 同步空闲再开测：提示条插进来会让行整体下移，点行/量位置的断言会落空
    await waitForSyncIdle(appPage)
  })

  test('A 宽屏阅读栏：翻篇后关闭，滚回刚读的那一条并闪一下', async ({ appPage }) => {
    expect(await clickFirstItem(appPage), '宽屏阅读栏：点开了一篇').toBe(true)
    await appPage.waitForTimeout(1_500)

    const first = await activeTitle(appPage)
    await pressNext(appPage, NEXT_CLICKS)
    const moved = await activeTitle(appPage)
    expect(moved && moved !== first, `宽屏阅读栏：连点「下一篇」翻到了别的篇目 → ${moved.slice(0, 24)}`).toBe(true)

    await verifyReveal(appPage, '宽屏阅读栏', async () => {
      await appPage.locator('[aria-label="关闭阅读栏"]').first().click()
    }, '[data-flash="true"]', 'A')
  })

  test('D 宽屏阅读栏：没翻篇直接关闭，不滚也不闪', async ({ appPage }) => {
    await verifyNoNavOnClose(appPage, '宽屏阅读栏（没翻篇）', async () => {
      await appPage.locator('[aria-label="关闭阅读栏"]').first().click()
    }, '[data-flash="true"]', 'D')
  })

  test('B 窄屏弹窗：翻篇后关闭，滚回刚读的那一条并闪一下', async ({ appPage }) => {
    await appPage.setViewportSize({ width: 390, height: 844 })
    await appPage.waitForTimeout(1_200)
    await scrollListToTop(appPage)

    expect(await clickFirstItem(appPage), '窄屏弹窗：点开了一篇').toBe(true)
    await appPage.waitForTimeout(1_500)
    await expect(appPage.locator(PANE), '窄屏弹窗：阅读栏不再挂载（弹窗与阅读栏互斥）').toHaveCount(0)

    const first = await activeTitle(appPage)
    await pressNext(appPage, NEXT_CLICKS)
    const moved = await activeTitle(appPage)
    expect(moved && moved !== first, `窄屏弹窗：连点「下一篇」翻到了别的篇目 → ${moved.slice(0, 24)}`).toBe(true)

    await verifyReveal(appPage, '窄屏弹窗', async () => {
      await appPage.locator(`${MODAL} button`, { hasText: '关闭' }).last().click()
    })
  })

  test('C 宽屏表格：翻篇后关闭，滚回刚读的那一行并闪一下', async ({ appPage }) => {
    console.log('[C] 切到表格视图…')
    await ensureListView(appPage, '表格')
    await waitForSyncIdle(appPage)
    await appPage.waitForTimeout(1_200)

    const tableRows = await appPage.locator('tbody tr').filter({ has: appPage.locator('[data-entry-id]') }).count()
    console.log(`[C] 表格行数=${tableRows}`)
    expect(tableRows, `表格视图：已渲染出行（${tableRows} 行）`).toBeGreaterThanOrEqual(8)
    const tableTop = (await listState(appPage)).scrollTop

    console.log('[C] 点开一行…')
    expect(await clickFirstTableRow(appPage), '表格视图：点开了一篇').toBe(true)
    await appPage.waitForTimeout(1_500)
    const first = await activeTitle(appPage)
    await pressNext(appPage, NEXT_CLICKS)
    const moved = await activeTitle(appPage)
    expect(moved && moved !== first, `表格视图：连点「下一篇」翻到了别的篇目 → ${moved.slice(0, 24)}`).toBe(true)
    // 表格行没有选中高亮（只有已读淡显），前置条件改用「翻页期间列表一寸没动」来钉：
    // 行高固定 53，翻 22 行 ≈ 1166px，已经远超一屏
    expect(
      (await listState(appPage)).scrollTop,
      `表格视图：翻页期间列表没有被推走（刚读的那条在视口外，scrollTop ${tableTop}）`
    ).toBe(tableTop)

    await verifyReveal(appPage, '表格视图', async () => {
      await closeAnyDetail(appPage)
    }, 'tr.entry-flash', 'C')
  })

  test('运行时没有新增 JS 错误', async ({ jsErrors }) => {
    expect(jsErrors.slice(0, 3), jsErrors.slice(0, 3).join(' | ')).toEqual([])
  })
})

/**
 * 关掉详情 → 校验「滚回刚才那条 + 闪一下」。
 * 关闭动作由调用方给：两个展示面的关闭按钮不同（阅读栏的 X / 弹窗的「关闭」）。
 * `flashSelector` 也由调用方给：滚动区看 data-flash 属性，表格看 entry-flash 类。
 *
 * 断言全部用 expect.soft：老脚本的口径是「一项失败继续跑后面的检查」，这样一次运行能拿到
 * 完整的失败清单，而不是停在第一个断言上。
 */
async function verifyReveal(
  page: Page,
  label: string,
  closeDetail: () => Promise<void>,
  flashSelector = '[data-flash="true"]',
  shotName = ''
) {
  const before = await listState(page)
  const title = await activeTitle(page)
  // 详情没打开时后面所有断言都没有意义，这一条用硬断言直接中止本用例
  expect(title, `${label}：拿不到正在读的标题（详情没打开？）`).not.toBe('')

  // 关掉之前先记下「在读的那一条」：高亮行渲染着就按 id 认，没渲染就说明它在视口外
  const read = await readItemState(page)
  expect.soft(read.visible, `${label}：前置条件——刚读的那篇在关掉前不在视口里（${read.detail}）`).toBe(false)

  await startScrollSampler(page, flashSelector)
  await closeDetail()
  // 标记在滚动停稳之后才挂上（约 1s+），所以这里要等得比「立刻闪」久一点。
  // 只等「挂上了」：等 visible 会被 Playwright 的可见性语义带偏（表格行尤其），
  // 位置对不对由下面的矩形断言回答。
  const flashed = await page
    .waitForSelector(flashSelector, { state: 'attached', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  expect.soft(flashed, `${label}：关掉详情后刚读的那条闪一下`).toBe(true)

  const state = await flashState(page, title, flashSelector)
  // 截图放在量完几何之后一点点：窄屏弹窗还在退场动画里，立刻截到的还是那篇文章而不是列表；
  // 但也别等太久 —— 闪烁动画 1.4s 就淡完了，截图要趁它还亮着（此刻列表已经滚到位）
  await page.waitForTimeout(300)
  await shot(page, `${shotName || (label === '宽屏阅读栏' ? 'A' : 'B')}-reveal`)

  // 等滚动停稳再核对落点：平滑滚动期间量到的位置还在路上
  const scroll = await stopScrollSampler(page)
  const landed = state.id ? await entryState(page, state.id) : { found: false, visible: false, detail: '' }
  const sameEntry = read.id ? state.id === read.id : state.matched
  expect.soft(state.found && sameEntry, `${label}：闪的是刚才读的那一篇（${state.id ?? '(没找到闪的那条)'}）`).toBe(true)
  expect.soft(state.visible === true, `${label}：闪的那条当时就在视口里（${state.geometry}）`).toBe(true)
  expect.soft(!!landed.visible, `${label}：刚读的那条落进了列表视口（${landed.detail}）`).toBe(true)
  expect.soft(
    scroll.end > before.scrollTop,
    `${label}：列表确实滚动了（不是原地闪一下，scrollTop ${scroll.start} → ${scroll.end}）`
  ).toBe(true)
  expect.soft(
    scroll.between.length >= 3,
    `${label}：是滚过去的（一路经过若干中间位置）而不是一步跳过去（${scroll.frames} 帧里经过 ${scroll.between.length} 个中间位置：${scroll.between.slice(0, 6).join(' → ')}）`
  ).toBe(true)
  expect.soft(
    scroll.stillDuringMotion <= 6,
    `${label}：滚起来之后是连续的，没有长时间卡住（第 ${scroll.firstMove} 帧动到第 ${scroll.lastMove} 帧，中间有 ${scroll.stillDuringMotion} 帧位置没变）`
  ).toBe(true)
  expect.soft(
    scroll.flashLitFrames >= 12 && scroll.flashAt >= scroll.lastMove - 3,
    `${label}：等滚到位了才闪（最后一次位移在第 ${scroll.lastMove} 帧，闪现在第 ${scroll.flashAt} 帧，之后 20 帧里亮了 ${scroll.flashLitFrames} 帧（共 ${scroll.frames} 帧））`
  ).toBe(true)
  expect.soft(state.animation === 'entry-flash', `${label}：闪烁动画真的挂上了（${state.animation}）`).toBe(true)

  // 等它自己摘掉（而不是盲等一段固定时间）：摘早了用户看不见、摘晚了会留成第二个「选中态」
  const gone = await page
    .waitForSelector(flashSelector, { state: 'detached', timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  expect.soft(gone, `${label}：闪烁到点自己退场，不留成第二个「选中态」`).toBe(true)
}

/**
 * 「没翻篇就关掉」的端到端复核：不滚也不闪。
 *
 * 要让这条断言有分量，前置条件必须是「旧行为会滚会闪」：详情开着的时候把列表滚走一段，
 * 让刚读的那条落到视口外 —— 若判据还是老的（关掉就定位），它必然滑回去并闪一下。
 * 新判据（useEntryModal 的 navigatedInDetail）下，位置必须停在用户自己滚到的地方。
 */
async function verifyNoNavOnClose(
  page: Page,
  label: string,
  closeDetail: () => Promise<void>,
  flashSelector: string,
  shotName: string
) {
  await scrollListToTop(page)
  const opened = await clickFirstItem(page)
  expect(opened, `${label}：点开了一篇`).toBe(true)
  await page.waitForTimeout(1_500)
  const read = await readItemState(page)
  expect.soft(read.found && read.visible, `${label}：前置条件——关掉前刚读的那条在列表里看得见（${read.detail}）`).toBe(true)
  // 前置条件不成立就别往下走了：详情没开时关闭按钮是 disabled，点它会白等 30s 再抛异常
  if (!opened || !read.found) return

  // 详情开着时把列表滚走：不翻篇，只是让刚读的那条离开视口
  await scrollListBy(page, 600)
  const outOfView = await readItemState(page)
  expect.soft(
    !outOfView.visible,
    `${label}：前置条件——刚读的那条已被滚出视口（否则证明不了「不滚」；${outOfView.detail}）`
  ).toBe(true)
  const moved = (await listState(page)).scrollTop

  await startScrollSampler(page, flashSelector)
  await closeDetail()
  const flashed = await page
    .waitForSelector(flashSelector, { state: 'attached', timeout: 2_500 })
    .then(() => true)
    .catch(() => false)
  // 标记只挂 1.5s，等不到就等于没闪；再收一遍滚动采样确认位置没动
  const scroll = await stopScrollSampler(page, 1_500)
  expect.soft(flashed, `${label}：没翻篇直接返回，不再闪一下（仍然闪了）`).toBe(false)
  expect.soft(
    Math.abs(scroll.end - moved) <= 4,
    `${label}：列表停在用户自己滚到的位置（没有被拉回去，scrollTop ${moved} → ${scroll.end}，采样 ${scroll.frames} 帧）`
  ).toBe(true)
  // 截图留档：详情已退场、列表没动，此刻画面上没有任何闪烁标记
  await shot(page, `${shotName}-no-nav`)
}
