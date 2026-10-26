import type { Page } from 'playwright/test'
import { expect, shot, test } from './fixtures'
import {
  closeAnyDetail,
  ensureListView,
  ensureLoggedIn,
  ITEM,
  MODAL,
  PANE,
  SYNC_WAIT_MS,
  waitForList,
  waitForSyncIdle
} from './support/timeline'

/**
 * 「条目详情的地址」端到端验证：/rss/feed/:feedId/entry/:entryId
 * （从 scripts/verify-entry-route.mjs 迁到 Playwright Test）。
 *
 *   A. 瀑布流（弹窗）：点条目地址变成详情地址（段里只留 hash）、刷新／深链直达同一篇、
 *      返回键关闭、关闭退回列表页地址，且全程是同一页面（列表滚动位置不被推回顶部）；
 *   B. 翻篇：弹窗里的「下一篇」把地址一起换掉（replace，不往历史里压新记录）；
 *   C. 列表视图（宽屏阅读栏）：点条目进阅读栏（不弹窗）且地址同步，Esc 退回列表页地址，
 *      详情地址下侧边栏当前订阅源仍然高亮；
 *   D. 换到另一个源：上一源在读的文章不留在展示面上、也不变成弹窗；返回后那条地址的
 *      文章重新打开；
 *   E. 本地库没有这一篇：提示「找不到这篇文章」并退回列表页地址；
 *   F. 全程无新增 JS 运行时错误与 hydration 警告。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态与本地 PouchDB 存在
 * playwright.config.ts 指定的持久化 profile 里，第二次之后很快；profile 被清空时要重等
 * 一次首屏全量同步）。用例之间共享同一个页面（串行），每个用例自己把页面带到需要的状态。
 */
test.describe.configure({ mode: 'serial' })

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const TITLE_ANY = `${MODAL} h1, ${PANE} h1`
const PROSE_ANY = `${MODAL} .entry-prose, ${PANE} .entry-prose`
const NEXT_ANY = '[aria-label="下一篇"]'

/** 列表里的第一个真条目（单源页第 0 项是页头，点它不会打开详情） */
function firstEntryItem(page: Page) {
  return page.locator(ITEM).filter({ has: page.locator('[data-entry-id]') }).first()
}

/** 单源页：等本地库里有这个源的条目（同步可能还没扫到） */
async function gotoFeed(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  const start = Date.now()
  while (Date.now() - start < 180_000) {
    if ((await page.locator('[data-entry-id]').count()) > 0) break
    await page.waitForTimeout(5_000)
  }
  await page.waitForTimeout(1_200)
  await waitForSyncIdle(page, 60_000)
}

/** 等详情正文出现（不区分弹窗 / 阅读栏） */
async function waitProseAny(page: Page) {
  await page.locator(PROSE_ANY).first().waitFor({ timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function waitProse(page: Page, scope: string) {
  await page.locator(`${scope} .entry-prose`).first().waitFor({ timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(500)
}

/** 列表的滚动容器：离列表项最近的那个可滚动祖先（读或写滚动位置） */
async function nearestScroller(page: Page, action: 'read' | 'set', top = 0) {
  return page.evaluate(({ sel, action, top }) => {
    let el = document.querySelector(sel)?.parentElement ?? null
    while (el) {
      if (el.scrollHeight > el.clientHeight + 20) {
        if (action === 'set') el.scrollTop = top
        return el.scrollTop
      }
      el = el.parentElement
    }
    return -1
  }, { sel: ITEM, action, top })
}

/**
 * 点一个「此刻完整落在视口里」的条目，且**不让 Playwright 滚动**。
 *
 * 不能用 `locator.click()`：列表里没有完整可见的条目时它会先把元素滚进视口（把刚设好的
 * scrollTop 推回 0），「打开详情不重建列表」这条断言就被测试自己破坏了。这里用鼠标坐标点，
 * 找不到完整可见的条目就小步调整滚动位置再试（始终保持 scrollTop > 0）。
 */
async function clickVisibleItem(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const point = await page.evaluate((sel) => {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.querySelector('[data-entry-id]')) continue
        const r = el.getBoundingClientRect()
        // 用「中心落在视口内」而不是「整块都在视口内」：瀑布流卡片很高，滚到 700 之后
        // 可能一张都不完整露出来；点中心不会把列表滚走（断言要的是滚动位置保持）。
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        if (r.width > 0 && r.height > 0 && cy > 130 && cy < window.innerHeight - 80) {
          return { x: cx, y: cy }
        }
      }
      return null
    }, ITEM)
    if (point) {
      await page.mouse.click(point.x, point.y)
      return true
    }
    // 没有完整可见的条目：小步下滚再试（只影响滚动位置，不影响「没被推回顶部」的口径）
    await page.evaluate((sel) => {
      let scroller = document.querySelector(sel)?.parentElement ?? null
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
      if (scroller) scroller.scrollTop += 240
    }, ITEM)
    await page.waitForTimeout(400)
  }
  return false
}

/** history.state 里 vue-router 记的上一条地址（判断关闭是「退回去」还是「换掉」用） */
async function historyBack(page: Page) {
  const back = await page.evaluate(() => window.history.state?.back ?? null) as string | null
  return back ? back.replace(BASE, '') : null
}

const currentUrl = (page: Page) => page.url().replace(BASE, '')
/**
 * 地址比较前统一解码：vue-router 拼 URL 时不会把参数里的 `:`（条目 id 形如
 * `entry:<feedId>:<hash>`）转义，而我们构造地址时用的是 encodeURIComponent，
 * 两种写法指向同一条路由，比较时必须归一。
 */
const norm = (path: string) => decodeURIComponent(path)

/** 详情地址；入参是地址段里的 id（不是文档 id） */
function detailHref(feedId: string, urlId: string) {
  return `/rss/feed/${feedId}/entry/${encodeURIComponent(urlId)}`
}

/**
 * 地址段里的 id：文档 id 形如 `entry:<feedId>:<hash>`，而地址里只留 hash
 * （源已经写在地址路径里，见 utils/entryUrlId 与这里的同口径换算）。
 */
function urlIdOf(feedId: string, docId: string) {
  const prefix = `entry:${feedId}:`
  return docId.startsWith(prefix) ? docId.slice(prefix.length) : docId
}

// ── 会话级状态：登录、首屏列表、订阅源 id、控制台错误 ──────────────
const state: {
  feedHref: string
  feedId: string
  otherFeedId: string | null
} = { feedHref: '', feedId: '', otherFeedId: null }
const hydrationWarnings: string[] = []

test.describe('条目详情的地址', () => {
  test.beforeAll(async ({ appPage, jsErrors }) => {
    test.setTimeout(SYNC_WAIT_MS + 240_000)
    // 控制台监听要在任何导航之前挂上：hydration 警告只出现在首帧
    appPage.on('console', (message) => {
      if (/hydrat/i.test(message.text())) hydrationWarnings.push(`${message.type()}: ${message.text()}`)
    })
    // jsErrors 是 worker 级、可能带着上一个 spec 收集的条目：本文件只对自己跑期间的错误负责
    jsErrors.length = 0

    await ensureLoggedIn(appPage)
    await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
    expect(await waitForList(appPage, SYNC_WAIT_MS), '时间线加载出条目').toBe(true)
    await appPage.waitForTimeout(1_000)

    // 侧边栏的订阅源可能藏在折叠分组里；拿不到链接就从条目 id 反推（entry:<feedId>:<docId>）
    state.feedHref = await appPage.locator('a[href^="/rss/feed/"]').first()
      .getAttribute('href', { timeout: 3_000 })
      .catch(() => null) ?? ''
    if (!state.feedHref) {
      const entryId = await appPage.locator('[data-entry-id]').first().getAttribute('data-entry-id')
      const feedId = entryId?.split(':')[1]
      if (feedId) state.feedHref = `/rss/feed/${feedId}`
    }
    expect(state.feedHref, '拿得到订阅源链接（否则后面的地址断言无从谈起）').not.toBe('')
    state.feedId = decodeURIComponent(state.feedHref.replace('/rss/feed/', ''))

    // 另取一个「不是当前源」的源：侧边栏链接与条目 id（entry:<feedId>:<hash>）都能反推
    state.otherFeedId = await appPage.evaluate((sameAs) => {
      const candidates = new Set<string>()
      for (const el of document.querySelectorAll('a[href^="/rss/feed/"]')) {
        candidates.add(decodeURIComponent(el.getAttribute('href')!.replace('/rss/feed/', '')))
      }
      for (const el of document.querySelectorAll('[data-entry-id]')) {
        const feed = (el.getAttribute('data-entry-id') ?? '').split(':')[1]
        if (feed) candidates.add(feed)
      }
      return [...candidates].find(id => id && id !== sameAs) ?? null
    }, state.feedId)

    // 默认视图固定成瀑布流（走弹窗），保证断言与 profile 里残留的设置无关
    await appPage.evaluate(() => localStorage.setItem('app-settings', JSON.stringify({
      entryModalSize: 'sm:max-w-6xl',
      fixedBars: true,
      view: 'masonry'
    })))
  })

  test('A/B 瀑布流：地址、深链、返回键、翻篇与关闭', async ({ appPage }) => {
    // 订阅源自己配的默认视图（用户配置）优先于全局默认，不切的话这个源可能直接进三栏阅读栏，
    // 这一段的「弹窗」断言就不成立了（会话内切换优先于配置默认）
    await gotoFeed(appPage, state.feedHref)
    await ensureListView(appPage, '瀑布流')
    console.log(`[列表] 渲染出 ${await appPage.locator(ITEM).count()} 条`)

    const item = firstEntryItem(appPage)
    const entryId = await item.locator('[data-entry-id]').first().getAttribute('data-entry-id')
    expect(entryId, '单源页列表里有条目').toBeTruthy()
    const itemText = await item.innerText()
    const detailPath = detailHref(state.feedId, urlIdOf(state.feedId, entryId!))

    // ── A. 点条目 → 地址变详情地址 ──
    await item.click()
    await waitProse(appPage, MODAL)
    await appPage.waitForTimeout(400)

    expect.soft(norm(currentUrl(appPage)), `点条目后地址变成 /rss/feed/:feedId/entry/:entryId（${currentUrl(appPage)}）`)
      .toBe(norm(detailPath))
    expect.soft(
      currentUrl(appPage).split('/entry/')[1] === urlIdOf(state.feedId, entryId!)
      && !decodeURIComponent(currentUrl(appPage)).includes('entry:'),
      `地址里只留 hash（不带 entry:<feedId>: 前缀，${currentUrl(appPage)}）`
    ).toBe(true)
    expect.soft(
      await appPage.locator(`${MODAL} h1`).first().innerText().then(t => itemText.includes(t.trim())).catch(() => false),
      '弹窗打开且显示的就是那一篇'
    ).toBe(true)

    // 列表滚动位置：详情不切页面，滚过的地方不该被推回顶部
    await appPage.keyboard.press('Escape')
    await appPage.waitForTimeout(800)
    await nearestScroller(appPage, 'set', 700)
    await appPage.waitForTimeout(600)
    const scrolledBefore = await nearestScroller(appPage, 'read')
    const clicked = await clickVisibleItem(appPage)
    expect.soft(clicked, '列表里有视口内的条目可点（不触发自动滚动）').toBe(true)
    // 点不开详情后面所有断言都没有意义（innerText 会一直等不到），直接结束本用例
    if (!clicked) return
    await waitProse(appPage, MODAL)
    const scrolledAfter = await nearestScroller(appPage, 'read')
    expect.soft(
      scrolledBefore > 0 && scrolledAfter > 0,
      `打开详情是同一页面：列表没有被重建、也没被推回顶部（${scrolledBefore} → ${scrolledAfter}）`
    ).toBe(true)

    // 刷新 = 深链直达：同一篇应该直接打开
    const openedTitle = await appPage.locator(`${MODAL} h1`).first().innerText()
    const openedId = decodeURIComponent(currentUrl(appPage).split('/entry/')[1] ?? '')
    await appPage.reload({ waitUntil: 'domcontentloaded' })
    // 刷新会丢掉会话内切过的视图：这个源若配了「默认视图 = 列表」，深链打开后正文在阅读栏里
    // 而不是弹窗 —— 这里只断言「这一篇打开了」，展示面由 C 段单独钉
    await waitProseAny(appPage)
    await appPage.waitForTimeout(600)
    expect.soft(norm(currentUrl(appPage)), `刷新（深链）后地址不变（${currentUrl(appPage)}）`)
      .toBe(norm(detailHref(state.feedId, openedId)))
    // 用 > 0 而不是 == 1：正文里自带 <h1> 的条目会让标题选择器命中多个
    expect.soft(await appPage.locator(TITLE_ANY).count() > 0, '刷新（深链）后直接打开这一篇').toBe(true)
    expect.soft(
      await appPage.locator(TITLE_ANY).first().innerText() === openedTitle,
      `深链打开的正文与刷新前一致（${openedTitle.slice(0, 40)}）`
    ).toBe(true)
    expect.soft(await appPage.locator(ITEM).count() > 0, '深链打开时列表在其后正常渲染').toBe(true)
    await shot(appPage, 'A-deeplink-open')

    // 浏览器返回键：地址回列表页、详情关闭
    await appPage.goBack()
    await appPage.waitForTimeout(1_400)
    expect.soft(currentUrl(appPage), `返回键退回列表页地址（${currentUrl(appPage)}）`).toBe(state.feedHref)
    expect.soft(await appPage.locator(PROSE_ANY).count() === 0, '返回键关闭了详情').toBe(true)

    // ── B. 翻篇：地址跟着换（replace，不压历史） ──
    await firstEntryItem(appPage).click()
    await waitProseAny(appPage)
    const navBtn = appPage.locator(NEXT_ANY)
    const canNext = (await navBtn.count()) > 0 && await navBtn.isEnabled().catch(() => false)
    if (!canNext) {
      // 只有一条时无法验证翻篇：作为软失败记下来，不静默跳过
      expect.soft(canNext, '列表里有多于一篇文章，能验证「下一篇」').toBe(true)
    } else {
      const beforeUrl = currentUrl(appPage)
      const beforeTitle = await appPage.locator(TITLE_ANY).first().innerText()
      const backBefore = await historyBack(appPage)
      await navBtn.click()
      await appPage.waitForTimeout(1_600)
      const afterUrl = currentUrl(appPage)
      expect.soft(
        afterUrl !== beforeUrl && afterUrl.startsWith(`${state.feedHref}/entry/`),
        `「下一篇」后地址换成新的一篇（${afterUrl}）`
      ).toBe(true)
      expect.soft(
        await appPage.locator(TITLE_ANY).first().innerText() !== beforeTitle,
        '「下一篇」后正文也换了'
      ).toBe(true)
      expect.soft(
        await historyBack(appPage) === backBefore,
        `翻篇走 replace：history 的上一条仍是列表页（没被推进新记录，back=${await historyBack(appPage)}）`
      ).toBe(true)
    }

    // 关闭按钮：地址退回列表页（弹窗的「关闭」与阅读栏的 X 都算，两个面互斥挂载）
    await closeAnyDetail(appPage)
    await appPage.waitForTimeout(1_400)
    expect.soft(currentUrl(appPage), `关闭详情把地址退回列表页（${currentUrl(appPage)}）`).toBe(state.feedHref)
    expect.soft(await appPage.locator(PROSE_ANY).count() === 0, '关闭后详情不再渲染').toBe(true)

    // 从列表点开走 push：history 的上一条就是列表页，关闭时应当退回去（而不是留下重复地址）
    await firstEntryItem(appPage).click()
    await waitProseAny(appPage)
    expect.soft(
      await historyBack(appPage) === state.feedHref,
      `从列表点开走 push：history 的上一条是列表页（back=${await historyBack(appPage)}）`
    ).toBe(true)
    await closeAnyDetail(appPage)
    await appPage.waitForTimeout(1_400)
    expect.soft(
      currentUrl(appPage) === state.feedHref,
      `关闭后回到列表页地址且历史里没留重复的详情地址（${currentUrl(appPage)}）`
    ).toBe(true)

    // 深链冷加载后关闭：没有可退的历史，用 replace 退回列表页（不该退到应用外）
    await appPage.goto(`${BASE}${detailPath}`, { waitUntil: 'domcontentloaded' })
    await waitProseAny(appPage)
    expect.soft(await appPage.locator(TITLE_ANY).count() > 0, '深链冷加载：详情打开').toBe(true)
    await closeAnyDetail(appPage)
    await appPage.waitForTimeout(1_400)
    expect.soft(currentUrl(appPage), `深链冷加载后关闭：地址回到列表页（${currentUrl(appPage)}）`).toBe(state.feedHref)
  })

  test('C/D 列表视图：阅读栏地址、侧边栏高亮、切源不残留', async ({ appPage }) => {
    await gotoFeed(appPage, state.feedHref)
    await ensureListView(appPage, '列表')
    expect.soft(await appPage.locator(PANE).count() === 1, '切到列表视图：阅读栏出现').toBe(true)
    await appPage.waitForTimeout(500)

    const paneItem = firstEntryItem(appPage)
    const paneEntryId = await paneItem.locator('[data-entry-id]').first().getAttribute('data-entry-id')
    await paneItem.click()
    await waitProse(appPage, PANE)
    expect.soft(
      await appPage.locator(PANE).count() === 1 && await appPage.locator(MODAL).count() === 0,
      '列表视图点条目：正文进阅读栏而不是弹窗'
    ).toBe(true)
    expect.soft(
      norm(currentUrl(appPage)),
      `列表视图点条目：地址同步为详情地址（${currentUrl(appPage)}）`
    ).toBe(norm(detailHref(state.feedId, urlIdOf(state.feedId, paneEntryId!))))

    const paneNext = appPage.locator(`${PANE} [aria-label="下一篇"]`)
    if (await paneNext.isEnabled().catch(() => false)) {
      const beforePaneUrl = currentUrl(appPage)
      await paneNext.click()
      await appPage.waitForTimeout(1_600)
      expect.soft(
        currentUrl(appPage) !== beforePaneUrl && currentUrl(appPage).startsWith(`${state.feedHref}/entry/`),
        `阅读栏「下一篇」也把地址一起换掉（${currentUrl(appPage)}）`
      ).toBe(true)
    } else {
      expect.soft(false, '阅读栏里有下一篇，能验证阅读栏翻篇').toBe(true)
    }
    await shot(appPage, 'C-reader-pane')

    // 详情地址下侧边栏当前订阅源仍然高亮（FeedNavigation 解析路由时不该把 /entry/... 混进 id）
    const activeHrefs = await appPage.evaluate(() =>
      Array.from(document.querySelectorAll('a[aria-current][href^="/rss/feed/"]')).map(el => el.getAttribute('href')))
    expect.soft(
      activeHrefs.includes(state.feedHref),
      `详情地址下侧边栏当前订阅源仍然高亮（active=${activeHrefs.join(',')}）`
    ).toBe(true)

    // Esc 关闭阅读栏：地址退回列表页
    await appPage.keyboard.press('Escape')
    await appPage.waitForTimeout(1_200)
    expect.soft(currentUrl(appPage), `阅读栏 Esc 退出：地址退回列表页（${currentUrl(appPage)}）`)
      .toBe(state.feedHref)

    // ── D. 切到另一个源：上一源在读的文章不能留在展示面上（尤其不能变成弹窗）──
    if (!state.otherFeedId || state.otherFeedId === state.feedId) {
      expect.soft(false, '本地库里有第二个源，能验证切源').toBe(true)
      return
    }
    await appPage.goto(`${BASE}${state.feedHref}`, { waitUntil: 'domcontentloaded' })
    await appPage.waitForTimeout(1_500)
    if ((await appPage.locator(PANE).count()) === 0) await ensureListView(appPage, '列表')
    await firstEntryItem(appPage).click()
    await waitProse(appPage, PANE)
    expect.soft(await appPage.locator(`${PANE} .entry-prose`).count() > 0, '切源前：文章在阅读栏里').toBe(true)

    // 应用内导航到另一个源（等同点侧边栏；分组折叠时侧边栏不一定有链接，直接推路由）
    await appPage.evaluate(
      id => (document.querySelector('#__nuxt') as unknown as {
        __vue_app__?: { config: { globalProperties: { $router: { push: (path: string) => unknown } } } }
      }).__vue_app__?.config.globalProperties.$router.push(`/rss/feed/${id}`),
      state.otherFeedId
    )
    let stale = 0
    let modalEver = 0
    for (const wait of [150, 400, 900, 1_800]) {
      await appPage.waitForTimeout(wait)
      const now = await appPage.evaluate(({ pane, modal }) => ({
        stale: document.querySelectorAll(`${pane} .entry-prose, ${modal} .entry-prose`).length,
        modal: document.querySelectorAll(modal).length
      }), { pane: PANE, modal: MODAL })
      stale = Math.max(stale, now.stale)
      modalEver = Math.max(modalEver, now.modal)
    }
    expect.soft(stale === 0, `切到另一个源：上一源的文章不再留在展示面上（残留正文 ${stale} 处）`).toBe(true)
    expect.soft(modalEver === 0, `切到另一个源：过程中没有冒出弹窗（弹窗出现 ${modalEver} 次采样）`).toBe(true)
    expect.soft(
      currentUrl(appPage),
      `切到另一个源：地址是那个源（${currentUrl(appPage)}）`
    ).toBe(`/rss/feed/${state.otherFeedId}`)

    // 浏览器返回 = 回到 A 的那篇：地址与详情重新对上
    await appPage.goBack()
    await appPage.waitForTimeout(2_000)
    const restored = await appPage.evaluate(({ pane, modal }) =>
      document.querySelectorAll(`${pane} .entry-prose, ${modal} .entry-prose`).length, { pane: PANE, modal: MODAL })
    expect.soft(restored > 0, `返回上一个源：那条地址对应的文章重新打开（正文 ${restored} 处）`).toBe(true)
    expect.soft(
      currentUrl(appPage).includes(`/rss/feed/${state.feedId}/entry/`),
      `返回后地址回到详情地址（${currentUrl(appPage)}）`
    ).toBe(true)
    await shot(appPage, 'F-switch-feed')
  })

  test('E 本地库没有这一篇：提示并退回列表页', async ({ appPage }) => {
    await appPage.goto(`${BASE}${detailHref(state.feedId, 'deadbeef0000')}`, { waitUntil: 'domcontentloaded' })
    await appPage.waitForTimeout(3_000)
    expect.soft(await appPage.getByText('找不到这篇文章').count() > 0, '本地库没有这一篇 → 提示「找不到这篇文章」').toBe(true)
    expect.soft(
      currentUrl(appPage),
      `本地库没有这一篇 → 地址退回列表页（${currentUrl(appPage)}）`
    ).toBe(state.feedHref)
    await shot(appPage, 'D-missing-entry')
  })

  test('F 全程无新增 JS 错误与 hydration 警告', async ({ appPage, jsErrors }) => {
    // 复原 settings，别把验证 profile 的 localStorage 留脏
    await appPage.evaluate(() => localStorage.removeItem('app-settings')).catch(() => {})
    expect.soft(jsErrors.slice(0, 3), jsErrors.slice(0, 3).join(' | ')).toEqual([])
    expect.soft(hydrationWarnings.slice(0, 2), hydrationWarnings.slice(0, 2).join(' | ')).toEqual([])
  })
})
