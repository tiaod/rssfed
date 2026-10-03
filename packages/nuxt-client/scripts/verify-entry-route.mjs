#!/usr/bin/env node
/**
 * 真实浏览器验证「条目详情的地址」：/rss/feed/:feedId/entry/:entryId。
 *
 *   A. 瀑布流（弹窗）：点条目地址变成详情地址（段里只留 hash）、刷新／深链直达同一篇、
 *      返回键关闭、关闭退回列表页地址，且全程是同一页面（列表滚动位置不被推回顶部）；
 *   B. 翻篇：弹窗里的「下一篇」把地址一起换掉（replace，不往历史里压新记录）；
 *   C. 列表视图（宽屏阅读栏）：点条目进阅读栏（不弹窗）且地址同步，Esc 退回列表页地址；
 *   D. 详情地址下侧边栏当前订阅源仍然高亮；
 *   E. 换到另一个源：上一源在读的文章不留在展示面上、也不变成弹窗；返回后那条地址的文章重新打开；
 *   F. 本地库没有这一篇：提示「找不到这篇文章」并退回列表页地址；
 *   G. 全程无新增 JS 运行时错误与 hydration 警告。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态 + 本地 PouchDB 存在
 * 持久化 profile 里，第二次之后很快；profile 被清空时要重等一次首屏全量同步）。
 * 用法：node packages/nuxt-client/scripts/verify-entry-route.mjs（或 pnpm verify:entry-route）
 *       环境变量：BASE_URL / OUT_DIR / PROFILE_DIR / SYNC_WAIT_MS。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, preparePlaywrightEnv } from './lib/playwright-env.mjs'

await preparePlaywrightEnv()
const { chromium } = await import('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
// 产物固定落在仓库根的 report/，不管从哪个目录调用（npm script 的 cwd 是子包）
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/entry-route')
// 默认落在 ~/.cache 而不是 /tmp：容器里 /tmp 会被清理，profile 一旦被清空就要重等一次全量同步
const PROFILE = process.env.PROFILE_DIR ?? `${process.env.HOME}/.cache/rssfed-playwright-profile`
/** 首屏全量同步（条目库带图片附件）可能要几分钟：等多久由这个上限决定 */
const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 1_200_000)
mkdirSync(OUT, { recursive: true })

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok]' : '[x]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const context = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1440, height: 900 }
})
const page = context.pages()[0] ?? await context.newPage()

const jsErrors = []
const hydrationWarnings = []
page.on('console', (m) => {
  const text = m.text()
  if (m.type() === 'error' && !text.startsWith('Failed to load resource')) jsErrors.push(text)
  if (/hydrat/i.test(text)) hydrationWarnings.push(`${m.type()}: ${text}`)
})
page.on('pageerror', e => jsErrors.push(`pageerror: ${String(e)}`))

const ITEM = '[data-slot="viewport"] > [data-slot="item"]'
// 详情有两个互斥的展示面：窄屏 / 非列表视图是弹窗，宽屏列表视图是常驻阅读栏。
// 与展示面无关的断言一律走下面这几个选择器（两边都渲染 EntryDetail，翻篇按钮同名）。
const TITLE_ANY = '.entry-detail-modal-content h1, [aria-label="文章阅读"] h1'
const PROSE_ANY = '.entry-detail-modal-content .entry-prose, [aria-label="文章阅读"] .entry-prose'
const NEXT_ANY = '[aria-label="下一篇"]'
const PANE = '[aria-label="文章阅读"]'
const MODAL = '.entry-detail-modal-content'

/** 列表里的第一个真条目（单源页第 0 项是页头，点它不会打开详情） */
function firstEntryItem() {
  return page.locator(ITEM).filter({ has: page.locator('[data-entry-id]') }).first()
}

async function ensureLoggedIn() {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"]', { timeout: 30_000 })
  // 必须等水合完成再提交：首帧表单还没有 @submit.prevent，点下去会走浏览器原生 GET 提交
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  await page.fill('input[type="email"]', 'admin@example.com')
  await page.fill('input[type="password"]', 'Admin123!')
  await page.click('button[type=submit]')
  await page.waitForURL('**/timeline', { timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
}

/** 切视图（菜单项名与 LIST_VIEW_META 的 label 一致） */
async function switchView(label) {
  await page.locator('[aria-label^="切换视图"]').click()
  await page.waitForTimeout(400)
  await page.getByRole('menuitemcheckbox', { name: label }).click()
  await page.waitForTimeout(1200)
}

async function gotoFeed(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  // 单源页的列表也要等本地库里有这个源的条目（同步可能还没扫到）
  const start = Date.now()
  while (Date.now() - start < 180_000) {
    if ((await page.locator('[data-entry-id]').count()) > 0) break
    await page.waitForTimeout(5_000)
  }
  await page.waitForTimeout(1200)
}

/** 等弹窗 / 阅读栏里的正文出来 */
async function waitProse(scope) {
  await page.locator(`${scope} .entry-prose`).first().waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(500)
}

/** 列表的滚动容器：离列表项最近的那个可滚动祖先 */
/** 关闭详情：弹窗点「关闭」，阅读栏点顶栏的 X（两个面互斥挂载） */
async function closeDetail() {
  const paneClose = page.locator('[aria-label="关闭阅读栏"]')
  if (await paneClose.count() > 0) {
    await paneClose.first().click()
    return
  }
  await page.locator(`${MODAL} button`, { hasText: '关闭' }).last().click()
}

/** 等详情正文出现（不区分弹窗 / 阅读栏） */
async function waitProseAny() {
  await page.locator(PROSE_ANY).first().waitFor({ timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(500)
}

function nearestScroller(action, top) {
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

/** 视口内的一个条目：点它不会让 Playwright 先滚动，滚动位置的前后对比才有意义 */
async function itemInViewport() {
  const items = page.locator(ITEM).filter({ has: page.locator('[data-entry-id]') })
  const n = await items.count()
  for (let i = 0; i < n; i++) {
    const box = await items.nth(i).boundingBox().catch(() => null)
    if (box && box.y > 120 && box.y + box.height < 820) return items.nth(i)
  }
  return items.first()
}

/** history.state 里 vue-router 记的上一条地址（判断关闭是「退回去」还是「换掉」用） */
const historyBack = async () => (await page.evaluate(() => window.history.state?.back ?? null))
  ?.replace(BASE, '') ?? null
const currentUrl = () => page.url().replace(BASE, '')
/**
 * 地址比较前统一解码：vue-router 拼 URL 时不会把参数里的 `:`（条目 id 形如
 * `entry:<feedId>:<hash>`）转义，而我们构造地址时用的是 encodeURIComponent，
 * 两种写法指向同一条路由，比较时必须归一。
 */
const norm = path => decodeURIComponent(path)

await ensureLoggedIn()
await page.goto(`${BASE}/timeline`, { waitUntil: 'domcontentloaded' })

// 首屏全量同步完成前时间线是空的：profile 被清过时要重等一次（带图片附件的条目库可能要几分钟）
const syncStart = Date.now()
while (Date.now() - syncStart < SYNC_WAIT_MS) {
  if ((await page.locator('[data-entry-id]').count()) > 0) break
  await page.waitForTimeout(10_000)
  console.log(`  …等待首屏同步 ${Math.round((Date.now() - syncStart) / 1000)}s`)
}
await page.waitForTimeout(1000)

// 侧边栏的订阅源可能藏在折叠分组里；拿不到链接就从条目 id 反推（entry:<feedId>:<docId>）
let feedHref = await page.locator('a[href^="/rss/feed/"]').first().getAttribute('href').catch(() => null)
if (!feedHref) {
  const entryId = await page.locator('[data-entry-id]').first().getAttribute('data-entry-id').catch(() => null)
  const feedId = entryId?.split(':')[1]
  if (feedId) feedHref = `/rss/feed/${feedId}`
}
if (!feedHref) {
  console.error('拿不到订阅源链接，无法验证')
  console.error('  url =', page.url())
  console.error('  items =', await page.locator(ITEM).count(), 'entryIds =', await page.locator('[data-entry-id]').count())
  console.error('  feedLinks =', await page.locator('a[href^="/rss/feed/"]').count())
  console.error('  body =', (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | '))
  await context.close()
  process.exit(1)
}
const feedId = decodeURIComponent(feedHref.replace('/rss/feed/', ''))
// 另取一个「不是当前源」的源：侧边栏链接与条目 id（entry:<feedId>:<hash>）都能反推
const otherFeedId = await page.evaluate((sameAs) => {
  const candidates = new Set()
  for (const el of document.querySelectorAll('a[href^="/rss/feed/"]')) {
    candidates.add(decodeURIComponent(el.getAttribute('href').replace('/rss/feed/', '')))
  }
  for (const el of document.querySelectorAll('[data-entry-id]')) {
    const feed = (el.getAttribute('data-entry-id') ?? '').split(':')[1]
    if (feed) candidates.add(feed)
  }
  return [...candidates].find(id => id && id !== sameAs) ?? null
}, feedId)
/**
 * 地址段里的 id：文档 id 形如 `entry:<feedId>:<hash>`，而地址里只留 hash
 * （源已经写在地址路径里，见 utils/entryUrlId 与这里的同口径换算）。
 */
const urlIdOf = (docId) => {
  const prefix = `entry:${feedId}:`
  return docId.startsWith(prefix) ? docId.slice(prefix.length) : docId
}
/** 详情地址；入参是地址段里的 id（不是文档 id） */
const detailHref = urlId => `/rss/feed/${feedId}/entry/${encodeURIComponent(urlId)}`
console.log(`[单源页] ${feedHref}（feedId=${feedId}）`)

// 默认视图固定成瀑布流（走弹窗），保证断言与 profile 里残留的设置无关
await page.evaluate(() => localStorage.setItem('app-settings', JSON.stringify({
  entryModalSize: 'sm:max-w-6xl',
  fixedBars: true,
  view: 'masonry'
})))

// ── A. 瀑布流：点条目 → 地址变详情地址 → 刷新直达 → 返回键关闭 ──
await gotoFeed(feedHref)
// 显式切到瀑布流：订阅源自己配的默认视图（用户配置）优先于全局默认，不切的话这个源可能
// 直接进三栏阅读栏，这一段的「弹窗」断言就不成立了（会话内切换优先于配置默认）
await switchView('瀑布流')
console.log(`[列表] 渲染出 ${await page.locator(ITEM).count()} 条`)
const item = firstEntryItem()
const entryId = await item.locator('[data-entry-id]').first().getAttribute('data-entry-id')
const itemText = await item.innerText()
check('单源页列表里有条目', !!entryId, `entry=${entryId}`)

await item.click()
await waitProse(MODAL)
await page.waitForTimeout(400)

check('点条目后地址变成 /rss/feed/:feedId/entry/:entryId', norm(currentUrl()) === norm(detailHref(urlIdOf(entryId))), currentUrl())
check('地址里只留 hash（不带 entry:<feedId>: 前缀）',
  currentUrl().split('/entry/')[1] === urlIdOf(entryId) && !decodeURIComponent(currentUrl()).includes('entry:'),
  currentUrl())
check('弹窗打开且显示的就是那一篇',
  await page.locator(`${MODAL} h1`).first().innerText().then(t => itemText.includes(t.trim())).catch(() => false))

// 列表滚动位置：详情不切页面，滚过的地方不该被推回顶部
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
await nearestScroller('set', 700)
await page.waitForTimeout(600)
const scrolledBefore = await nearestScroller('read')
const viewItem = await itemInViewport()
await viewItem.click()
await waitProse(MODAL)
const scrolledAfter = await nearestScroller('read')
check('打开详情是同一页面：列表没有被重建、也没被推回顶部',
  scrolledBefore > 0 && scrolledAfter > 0,
  `${scrolledBefore} → ${scrolledAfter}`)

// 刷新 = 深链直达：同一篇应该直接打开
const openedTitle = await page.locator(`${MODAL} h1`).first().innerText()
const openedId = decodeURIComponent(currentUrl().split('/entry/')[1] ?? '')
await page.reload({ waitUntil: 'domcontentloaded' })
// 刷新会丢掉会话内切过的视图：这个源若配了「默认视图 = 列表」，深链打开后正文在阅读栏里
// 而不是弹窗 —— 这里只断言「这一篇打开了」，展示面由 C 段单独钉
await waitProseAny()
await page.waitForTimeout(600)
check('刷新（深链）后地址不变', norm(currentUrl()) === norm(detailHref(openedId)), currentUrl())
// 用 > 0 而不是 == 1：正文里自带 <h1> 的条目会让标题选择器命中多个
check('刷新（深链）后直接打开这一篇', await page.locator(TITLE_ANY).count() > 0)
check('深链打开的正文与刷新前一致',
  (await page.locator(TITLE_ANY).first().innerText()) === openedTitle, openedTitle.slice(0, 40))
check('深链打开时列表在其后正常渲染', (await page.locator(ITEM).count()) > 0)
await page.screenshot({ path: `${OUT}/A-deeplink-open.png` })

// 浏览器返回键：地址回列表页、详情关闭
await page.goBack()
await page.waitForTimeout(1400)
check('返回键退回列表页地址', currentUrl() === feedHref, currentUrl())
check('返回键关闭了详情', await page.locator(PROSE_ANY).count() === 0)

// ── B. 翻篇：地址跟着换（replace，不压历史） ──
await firstEntryItem().click()
await waitProseAny()
const navBtn = page.locator(NEXT_ANY)
const canNext = (await navBtn.count()) > 0 && await navBtn.isEnabled().catch(() => false)
if (canNext) {
  const beforeUrl = currentUrl()
  const beforeTitle = await page.locator(TITLE_ANY).first().innerText()
  const backBefore = await historyBack()
  await navBtn.click()
  await page.waitForTimeout(1600)
  const afterUrl = currentUrl()
  check('「下一篇」后地址换成新的一篇',
    afterUrl !== beforeUrl && afterUrl.startsWith(`${feedHref}/entry/`), afterUrl)
  check('「下一篇」后正文也换了',
    (await page.locator(TITLE_ANY).first().innerText()) !== beforeTitle)
  check('翻篇走 replace：history 的上一条仍是列表页（没被推进新记录）',
    (await historyBack()) === backBefore, `back=${await historyBack()}`)
} else {
  console.log('[!] 列表里只有一条（或没有下一篇），跳过翻篇验证')
}

// 关闭按钮：地址退回列表页（弹窗的「关闭」与阅读栏的 X 都算，两个面互斥挂载）
await closeDetail()
await page.waitForTimeout(1400)
check('关闭详情把地址退回列表页', currentUrl() === feedHref, currentUrl())
check('关闭后详情不再渲染', await page.locator(PROSE_ANY).count() === 0)

// 从列表点开走 push：history 的上一条就是列表页，关闭时应当退回去（而不是留下重复地址）
await firstEntryItem().click()
await waitProseAny()
check('从列表点开走 push：history 的上一条是列表页', (await historyBack()) === feedHref, `back=${await historyBack()}`)
await closeDetail()
await page.waitForTimeout(1400)
check('关闭后回到列表页地址且历史里没留重复的详情地址', currentUrl() === feedHref, currentUrl())

// 深链冷加载后关闭：没有可退的历史，用 replace 退回列表页（不该退到应用外）
await page.goto(`${BASE}${detailHref(urlIdOf(entryId))}`, { waitUntil: 'domcontentloaded' })
await waitProseAny()
check('深链冷加载：详情打开', (await page.locator(TITLE_ANY).count()) > 0)
await closeDetail()
await page.waitForTimeout(1400)
check('深链冷加载后关闭：地址回到列表页', currentUrl() === feedHref, currentUrl())

// ── C. 列表视图（宽屏阅读栏）：地址同样承载条目 ──
await switchView('列表')
check('切到列表视图：阅读栏出现', (await page.locator(PANE).count()) === 1)
await page.waitForTimeout(500)
const paneItem = firstEntryItem()
const paneEntryId = await paneItem.locator('[data-entry-id]').first().getAttribute('data-entry-id')
await paneItem.click()
await waitProse(PANE)
check('列表视图点条目：正文进阅读栏而不是弹窗',
  (await page.locator(PANE).count()) === 1 && (await page.locator(MODAL).count()) === 0)
check('列表视图点条目：地址同步为详情地址', norm(currentUrl()) === norm(detailHref(urlIdOf(paneEntryId))), currentUrl())
const paneNext = page.locator(`${PANE} [aria-label="下一篇"]`)
if (await paneNext.isEnabled().catch(() => false)) {
  const beforePaneUrl = currentUrl()
  await paneNext.click()
  await page.waitForTimeout(1600)
  check('阅读栏「下一篇」也把地址一起换掉',
    currentUrl() !== beforePaneUrl && currentUrl().startsWith(`${feedHref}/entry/`), currentUrl())
} else {
  console.log('[!] 阅读栏里没有下一篇，跳过阅读栏翻篇验证')
}
await page.screenshot({ path: `${OUT}/C-reader-pane.png` })

// 详情地址下侧边栏当前订阅源仍然高亮（FeedNavigation 解析路由时不该把 /entry/... 混进 id）
const activeHrefs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('a[aria-current][href^="/rss/feed/"]')).map(el => el.getAttribute('href'))
)
check('详情地址下侧边栏当前订阅源仍然高亮', activeHrefs.includes(feedHref), `active=${activeHrefs.join(',')}`)

// Esc 关闭阅读栏：地址退回列表页
await page.keyboard.press('Escape')
await page.waitForTimeout(1200)
check('阅读栏 Esc 退出：地址退回列表页', currentUrl() === feedHref, currentUrl())

// ── F. 切到另一个源：上一源在读的文章不能留在展示面上（尤其不能变成弹窗）──
if (otherFeedId && otherFeedId !== feedId) {
  // 回到 A 的列表视图，重新在读一篇
  await page.goto(`${BASE}${feedHref}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  if ((await page.locator(PANE).count()) === 0) await switchView('列表')
  await firstEntryItem().click()
  await waitProse(PANE)
  check('切源前：文章在阅读栏里', (await page.locator(`${PANE} .entry-prose`).count()) > 0)

  // 应用内导航到另一个源（等同点侧边栏；分组折叠时侧边栏不一定有链接，直接推路由）
  await page.evaluate(
    id => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push(`/rss/feed/${id}`),
    otherFeedId
  )
  let stale = 0
  let modalEver = 0
  for (const wait of [150, 400, 900, 1800]) {
    await page.waitForTimeout(wait)
    const now = await page.evaluate(({ PANE, MODAL }) => ({
      stale: document.querySelectorAll(`${PANE} .entry-prose, ${MODAL} .entry-prose`).length,
      modal: document.querySelectorAll(MODAL).length
    }), { PANE, MODAL })
    stale = Math.max(stale, now.stale)
    modalEver = Math.max(modalEver, now.modal)
  }
  check('切到另一个源：上一源的文章不再留在展示面上', stale === 0, `残留正文 ${stale} 处`)
  check('切到另一个源：过程中没有冒出弹窗', modalEver === 0, `弹窗出现 ${modalEver} 次采样`)
  check('切到另一个源：地址是那个源', currentUrl() === `/rss/feed/${otherFeedId}`, currentUrl())

  // 浏览器返回 = 回到 A 的那篇：地址与详情重新对上
  await page.goBack()
  await page.waitForTimeout(2000)
  const restored = await page.evaluate(({ PANE, MODAL }) =>
    document.querySelectorAll(`${PANE} .entry-prose, ${MODAL} .entry-prose`).length, { PANE, MODAL })
  check('返回上一个源：那条地址对应的文章重新打开', restored > 0, `正文 ${restored} 处`)
  check('返回后地址回到详情地址', currentUrl().includes(`/rss/feed/${feedId}/entry/`), currentUrl())
  await page.screenshot({ path: `${OUT}/F-switch-feed.png` })
} else {
  console.log('[!] 只有一个源，跳过切源验证')
}

// ── D. 本地库没有这一篇 ──
await page.goto(`${BASE}${detailHref('deadbeef0000')}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
check('本地库没有这一篇 → 提示「找不到这篇文章」', (await page.getByText('找不到这篇文章').count()) > 0)
check('本地库没有这一篇 → 地址退回列表页', currentUrl() === feedHref, currentUrl())
await page.screenshot({ path: `${OUT}/D-missing-entry.png` })

// ── E. 控制台 ──
check('无新增 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
check('无 hydration 警告', hydrationWarnings.length === 0, hydrationWarnings.slice(0, 2).join(' | '))

// 复原 settings，别把验证 profile 的 localStorage 留脏
await page.evaluate(() => localStorage.removeItem('app-settings'))

const failed = results.filter(r => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
}

await context.close()
process.exit(failed.length ? 1 : 0)
