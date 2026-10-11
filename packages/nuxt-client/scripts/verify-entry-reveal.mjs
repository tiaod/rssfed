#!/usr/bin/env node
/**
 * 「关掉详情后回到刚才读的那一条」端到端验证。
 *
 * 场景：连点多次「下一篇」翻了很多篇再关掉详情，列表还停在最初点开的那一条上 ——
 * 不自动滚回去，用户得往下翻很久才找得到自己读到哪儿（宽屏阅读栏则是选中高亮跑到了视口外）。
 * 本次改动的口径（见 EntryList 的 revealEntry）：
 *   1. 刚读的那条在视口外 → 平滑滚过去并居中，并且**滚到位之后才闪**
 *      （前者靠逐帧采样滚动位置证明，后者靠采样里「闪过的那一帧在最后一次位移之后」证明）；
 *   2. 已经看得见的那条只闪不滚（不推走用户当前的滚动位置）；
 *   3. 闪一下的动画自己退场（约 1.5s），不留成第二个「选中态」；
 *   4. 条目不在当前列表里（换源 / 被「只看未读」筛掉）时什么都不做 —— 这条由 vitest 覆盖
 *      （单测能构造当前列表里没有的那一篇，浏览器里不好摆）；
 *   5. **没点过上一篇 / 下一篇就关掉（读完直接返回）时，既不滚也不闪** —— 列表还停在点开的那条上，
 *      再定位再闪只是打扰（见 useEntryModal 的 navigatedInDetail）。这条同样由 vitest 覆盖，
 *      浏览器里跑的是它最不容易造假的那一面：详情开着时把列表滚走让刚读的那条落到视口外，
 *      关掉之后位置必须一丝不动（旧行为会滑回去并闪一下）。
 *
 * 两个展示面互斥挂载，都要走一遍：
 *   A. 宽屏（1440×900）+ 列表视图：右侧常驻阅读栏，点 X 关闭后定位；
 *   B. 窄屏（390×844）+ 列表视图：全屏弹窗，按「关闭」后定位；
 *   C. 宽屏（1440×900）+ 表格视图：行由 UTable 生成，标记只能挂 entry-flash 类，
 *      定位走根节点的 scrollTo —— 与 A/B 是两条不同的代码路径，都要走一遍；
 *   D. 宽屏 + 列表视图：点开一篇、不翻篇、关掉 —— 口径 5 的端到端复核（接在 A 后面跑，仍是宽屏阅读栏）。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态 + 本地 PouchDB 存在
 * 持久化 profile 里，第二次之后很快；profile 被清空时要重等一次首屏全量同步）。
 * 用法：node packages/nuxt-client/scripts/verify-entry-reveal.mjs（或 pnpm verify:entry-reveal）
 *       环境变量：BASE_URL / OUT_DIR / PROFILE_DIR / SYNC_WAIT_MS。
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, preparePlaywrightEnv } from './lib/playwright-env.mjs'

await preparePlaywrightEnv()
const { chromium } = await import('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
// 产物固定落在仓库根的 report/，不管从哪个目录调用（npm script 的 cwd 是子包）
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/entry-reveal')
// 默认落在 ~/.cache 而不是 /tmp：容器里 /tmp 会被清理，profile 一旦被清空就要重等一次全量同步
const PROFILE = process.env.PROFILE_DIR ?? `${process.env.HOME}/.cache/rssfed-playwright-profile`
/** 首屏全量同步（条目库带图片附件）可能要几分钟：等多久由这个上限决定 */
const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 1_200_000)
/** 翻多少篇「下一篇」：列表行高 96，翻 22 篇 ≈ 2100px，必然把刚读的那条推出视口 */
const NEXT_CLICKS = 22
const PANE = '[aria-label="文章阅读"]'
const MODAL = '.entry-detail-modal-content'
const ITEM = '[data-slot="viewport"] > [data-slot="item"]'

fs.mkdirSync(OUT, { recursive: true })

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok]' : '[x] '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const context = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1440, height: 900 }
})
const page = context.pages()[0] ?? await context.newPage()

const jsErrors = []
page.on('console', (m) => {
  const text = m.text()
  if (m.type() !== 'error' || text.startsWith('Failed to load resource')) return
  // 只看应用自己（:3000）发出来的：正文里嵌的第三方 iframe（视频、追踪脚本）会把
  // 自己的 console 一并带进来，那不是这次改动要盯的东西
  const from = m.location()?.url ?? ''
  if (from && !from.startsWith(BASE)) return
  jsErrors.push(text.slice(0, 300))
})
page.on('pageerror', e => jsErrors.push(`pageerror: ${String(e).slice(0, 300)}`))

async function ensureLoggedIn() {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"]', { timeout: 30_000 })
  // 必须等水合完成再提交：首帧表单还没有 @submit.prevent，点下去会走浏览器原生 GET 提交
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1_500)
  await page.fill('input[type="email"]', 'admin@example.com')
  await page.fill('input[type="password"]', 'Admin123!')
  await page.locator('button[type="submit"]').first().click()
  await page.waitForURL('**/timeline', { timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
}

/** 等时间线列表真正渲染出条目（首次进入要先做一轮 PouchDB 同步，可能很慢） */
async function waitForList(timeout) {
  const start = Date.now()
  let applies = 0
  while (Date.now() - start < timeout) {
    if ((await page.locator('[data-entry-id]').count()) > 0) return true
    // 本地库还空着：同步拿到的新条目会折叠进「已同步 N 条」提示条，点「查看」才上屏
    const apply = page.getByRole('button', { name: '查看' })
    if ((await apply.count()) > 0 && await apply.first().isVisible().catch(() => false)) {
      await apply.first().click().catch(() => {})
      applies += 1
      await page.waitForTimeout(1_500)
      continue
    }
    await page.waitForTimeout(5_000)
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed % 15 < 6) console.log(`  …等待首屏同步 ${elapsed}s（查看 ×${applies}）`)
  }
  return false
}

/** 切视图（菜单项名与 LIST_VIEW_META 的 label 一致） */
async function switchView(label) {
  await page.locator('[aria-label^="切换视图"]').click()
  await page.waitForTimeout(400)
  await page.getByRole('menuitemcheckbox', { name: label }).click()
  await page.waitForTimeout(1_200)
}

/** 列表的滚动容器：离条目最近的那个可滚动祖先（与页面自己定位滚动容器的口径一致） */
const SCROLLER = `(() => {
  let el = document.querySelector('[data-entry-id]')?.parentElement ?? null
  while (el && !(el.scrollHeight > el.clientHeight + 20)) el = el.parentElement
  return el
})()`

async function listState() {
  return page.evaluate(`(() => {
    const el = ${SCROLLER}
    return {
      scrollTop: Math.round(el?.scrollTop ?? -1),
      clientHeight: Math.round(el?.clientHeight ?? 0),
      scrollHeight: Math.round(el?.scrollHeight ?? 0),
      items: document.querySelectorAll('[data-entry-id]').length
    }
  })()`)
}

async function scrollListToTop() {
  await page.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop = 0 })()`)
  await page.waitForTimeout(600)
}

/**
 * 列表里铺开的内容够不够验证翻页。
 *
 * 首次同步还在进行时，本地库里的条目是分批到的：新到的那批折叠进「已同步 N 条」提示条，
 * 点「查看」才上屏。这里点到「列表至少有两屏」为止 —— 条目太少的话，连点「下一篇」根本
 * 推不出视口，验证的前提（刚读的那篇在视口外）就不成立了。
 */
async function ensureEnoughItems(timeout) {
  const start = Date.now()
  let state = await listState()
  while (Date.now() - start < timeout) {
    if (state.items >= 8 && state.clientHeight > 0 && state.scrollHeight >= state.clientHeight * 2) return state
    const apply = page.getByRole('button', { name: '查看' })
    if ((await apply.count()) > 0 && await apply.first().isVisible().catch(() => false)) {
      await apply.first().click().catch(() => {})
      await page.waitForTimeout(1_500)
    } else {
      // 没有提示条就把列表滚到底触发触底加载，再回到顶部
      await page.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop = el.scrollHeight })()`)
      await page.waitForTimeout(1_500)
      await scrollListToTop()
    }
    state = await listState()
  }
  return state
}

/**
 * 「正在读的那一条」在列表里的状态。
 *
 * 认选中高亮（列表行的 `bg-primary/10`，见 EntryRowItem 的 selected）而不是标题：
 * 高亮是列表自己标的，id 也一并拿得到，而标题比较容易被截断 / 空白差异带偏。
 * 找不到高亮行 = 虚拟化根本没渲染它 = 它在视口外，这本身就是「要往下翻很久」的成因。
 */
async function readItemState() {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-entry-id]')]
      .find(node => (node.getAttribute('class') ?? '').includes('bg-primary/10'))
    if (!el) return { found: false, visible: false, detail: '列表里没有渲染出选中高亮（在视口外）' }
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
    const box = scroller?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return {
      found: true,
      id: el.getAttribute('data-entry-id'),
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      detail: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`
    }
  })
}

/**
 * 当前展示面上那篇的标题（宽屏是阅读栏，窄屏是弹窗的活动槽）。
 *
 * 要排掉正在淡出的那一层：切篇是交叉淡入淡出（见 EntryDetailModal 的 .entry-fade），
 * 退场的那篇此刻仍在 DOM 里并且排在前面，直接取第一个 h1 会读到上一篇。
 */
async function activeTitle() {
  return page.evaluate(({ pane, modal }) => {
    const scope = document.querySelector('.swiper-slide-active')
      ?? document.querySelector(modal)
      ?? document.querySelector(pane)
    if (!scope) return ''
    const live = [...scope.querySelectorAll('h1')].filter(el => !el.closest('.entry-fade-leave-active'))
    return (live.at(-1)?.textContent ?? '').trim()
  }, { pane: PANE, modal: MODAL })
}

/**
 * 刚闪的那条：位置、动画、以及它是不是用户刚读的那篇（标记只挂 1.5s，要趁早问）。
 *
 * `flashSelector` 随视图不同：滚动区的条目挂 data-flash（子组件根节点透传），
 * 表格的行由 UTable 生成、挂不了自定义属性，只能加 entry-flash 类。
 * 认「行文本里含标题开头」而不是只找 h3 —— 表格行里没有 h3，标题只是普通文本节点。
 */
async function flashState(title, flashSelector) {
  return page.evaluate(({ want, selector }) => {
    const norm = s => (s ?? '').replace(/\s+/g, '')
    const el = document.querySelector(selector)
    if (!el) return { found: false }
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
    const box = scroller?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      found: true,
      id: el.getAttribute('data-entry-id') ?? el.querySelector('[data-entry-id]')?.getAttribute('data-entry-id'),
      matched: norm(el.textContent).includes(norm(want).slice(0, 30)),
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      geometry: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`,
      animation: style.animationName,
      scrollTop: Math.round(scroller?.scrollTop ?? -1)
    }
  }, { want: title, selector: flashSelector })
}

/** 某条（按 id 认）此刻在列表里的位置 —— 闪的标记已经摘掉之后，靠它复核最终落点 */
async function entryState(id) {
  return page.evaluate((want) => {
    const cell = [...document.querySelectorAll('[data-entry-id]')]
      .find(node => node.getAttribute('data-entry-id') === want)
    // 表格里 data-entry-id 在来源格上，要定位的是它所在的 tr（同 EntryList 的 revealElement）
    const el = cell?.closest('tr') ?? cell
    if (!el) return { found: false, detail: '定位之后列表里仍没有这一条的节点' }
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
    const box = scroller?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return {
      found: true,
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      detail: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`
    }
  }, id)
}

/**
 * 起一个逐帧采样器，量「关掉详情之后滚动位置是怎么变的」。
 *
 * 平滑滚动会经过一串中间位置，而 `scrollTop = 目标值` 这种一步到位的写法只会有首尾两个值；
 * 采样必须逐帧（60fps），隔几十毫秒去问一次已经跟不上动画了。
 */
async function startScrollSampler(flashSelector) {
  await page.evaluate(`(() => {
    const el = ${SCROLLER}
    const selector = ${JSON.stringify(flashSelector)}
    window.__reveal = { samples: [], raf: 0 }
    const tick = () => {
      window.__reveal.samples.push({
        top: Math.round(el?.scrollTop ?? -1),
        flash: !!document.querySelector(selector)
      })
      window.__reveal.raf = requestAnimationFrame(tick)
    }
    tick()
  })()`)
}

/** 等到滚动停稳（连续几帧同一个值），再收走采样结果 */
async function stopScrollSampler(budgetMs = 3_000) {
  const deadline = Date.now() + budgetMs
  let last = null
  let stable = 0
  while (Date.now() < deadline) {
    const current = await page.evaluate('window.__reveal?.samples?.at(-1)?.top ?? -1')
    stable = current === last ? stable + 1 : 0
    last = current
    if (stable >= 4) break
    await page.waitForTimeout(50)
  }
  return page.evaluate(`(() => {
    cancelAnimationFrame(window.__reveal.raf)
    const samples = window.__reveal.samples ?? []
    const tops = samples.map(s => s.top)
    const first = tops[0] ?? -1
    const end = tops.at(-1) ?? -1
    const between = [...new Set(tops.filter(v => v > first && v < end))]
    // 最后一次位移发生在第几帧：闪的标记必须出现在它之后（滚完再闪）
    let lastMove = 0
    for (let i = 1; i < tops.length; i++) if (tops[i] !== tops[i - 1]) lastMove = i
    const firstMove = tops.findIndex((top, i) => i > 0 && top !== tops[i - 1])
    const flashAt = samples.findIndex(s => s.flash)
    // 闪过之后还亮着的帧数：采样尾巴可能比 1.5s 的标记还长（标记到点自己摘掉是正常的），
    // 所以不能拿「最后一帧还亮着」当判据 —— 要的是它亮够了（动画 1.4s，看得见）
    const flashLitFrames = samples.slice(Math.max(flashAt, 0), Math.max(flashAt, 0) + 20)
      .filter(s => s.flash).length
    // 动起来之后有没有「卡住不动」的空档：一卡一卡正是这么来的（滚动途中位置连着很多帧不变）
    let stillDuringMotion = 0
    for (let i = Math.max(firstMove, 1); i <= lastMove; i++) {
      if (samples[i].top === samples[i - 1].top) stillDuringMotion += 1
    }
    return {
      start: first,
      end,
      between,
      frames: samples.length,
      firstMove,
      lastMove,
      stillDuringMotion,
      flashAt,
      flashLitFrames
    }
  })()`)
}

/** 点列表里视口内的第一个条目（不让 Playwright 自己滚动，滚动位置前后对比才有意义） */
async function clickFirstItem() {
  const height = page.viewportSize()?.height ?? 900
  const items = page.locator(ITEM).filter({ has: page.locator('[data-entry-id]') })
  const count = await items.count()
  for (let i = 0; i < count; i++) {
    const box = await items.nth(i).boundingBox().catch(() => null)
    // 顶部 120px 留给「已同步 N 条」提示条，底部留一点余量
    if (!box || box.y < 120 || box.y + box.height > height - 60) continue
    await items.nth(i).locator('button').first().click()
    return true
  }
  return false
}

/**
 * 点表格里视口内的第一行，并确认详情真的开了。
 *
 * 表格不是 ScrollArea 泳道（没有 data-slot=item 那层壳），行就是 UTable 生成的 tr，
 * 得点行内内容而不是 tr 本身。**别点第一格（来源格里有链接，点上去的语义不一定是「读这篇」）**，
 * 点标题格；真没开再退回「点整行」，都不行返回 false —— 调用方拿到的是确认过的事实。
 */
async function clickFirstTableRow() {
  const height = page.viewportSize()?.height ?? 900
  const rows = page.locator('tbody tr').filter({ has: page.locator('[data-entry-id]') })
  const count = await rows.count()
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox().catch(() => null)
    // 顶部 120px 留给「已同步 N 条」提示条与表头，底部留一点余量
    if (!box || box.y < 120 || box.y + box.height > height - 60) continue
    await rows.nth(i).locator('td').nth(1).click()
    await page.waitForTimeout(500)
    if (await page.locator(`${MODAL} h1`).count()) return true
    await rows.nth(i).click()
    await page.waitForTimeout(500)
    if (await page.locator(`${MODAL} h1`).count()) return true
  }
  return false
}

/** 关掉当前展示面：阅读栏挂的是 X，弹窗挂的是「关闭」——两个展示面互斥，按谁在就用谁 */
async function closeAnyDetail() {
  if ((await page.locator('[aria-label="关闭阅读栏"]').count()) > 0) {
    await page.locator('[aria-label="关闭阅读栏"]').first().click()
    return
  }
  await page.locator(`${MODAL} button`, { hasText: '关闭' }).last().click()
}

/** 连点「下一篇」：宽屏用键盘（阅读栏与弹窗都监听 ←/→），窄屏弹窗底部浮钮不渲染，同样走键盘 */
async function pressNext(times) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(90)
  }
}

/**
 * 关掉详情 → 校验「滚回刚才那条 + 闪一下」。
 * 关闭动作由调用方给：两个展示面的关闭按钮不同（阅读栏的 X / 弹窗的「关闭」）。
 * `flashSelector` 也由调用方给：滚动区看 data-flash 属性，表格看 entry-flash 类。
 */
async function verifyReveal(label, closeDetail, flashSelector = '[data-flash="true"]', shot = '') {
  const before = await listState()
  const title = await activeTitle()
  if (!title) {
    check(`${label}：拿不到正在读的标题（详情没打开？）`, false)
    return
  }
  // 关掉之前先记下「在读的那一条」：高亮行渲染着就按 id 认，没渲染就说明它在视口外
  const read = await readItemState()
  check(`${label}：前置条件——刚读的那篇在关掉前不在视口里`, !read.visible, read.detail)

  await startScrollSampler(flashSelector)
  await closeDetail()
  // 标记在滚动停稳之后才挂上（约 1s+），所以这里要等得比「立刻闪」久一点。
  // 只等「挂上了」：等 visible 会被 Playwright 的可见性语义带偏（表格行尤其），
  // 位置对不对由下面的矩形断言回答。
  const flashed = await page
    .waitForSelector(flashSelector, { state: 'attached', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  check(`${label}：关掉详情后刚读的那条闪一下`, flashed)

  const state = await flashState(title, flashSelector)
  // 截图放在量完几何之后一点点：窄屏弹窗还在退场动画里，立刻截到的还是那篇文章而不是列表；
  // 但也别等太久 —— 闪烁动画 1.4s 就淡完了，截图要趁它还亮着（此刻列表已经滚到位）
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/${shot || (label === '宽屏阅读栏' ? 'A' : 'B')}-reveal.png` })

  // 等滚动停稳再核对落点：平滑滚动期间量到的位置还在路上
  const scroll = await stopScrollSampler()
  const landed = state.id ? await entryState(state.id) : { found: false, detail: '' }
  const sameEntry = read.id ? state.id === read.id : state.matched
  check(`${label}：闪的是刚才读的那一篇`, state.found && sameEntry, state.id ?? '(没找到闪的那条)')
  check(`${label}：闪的那条当时就在视口里`, state.visible === true, state.geometry)
  check(`${label}：刚读的那条落进了列表视口`, !!landed.visible, landed.detail)
  check(`${label}：列表确实滚动了（不是原地闪一下）`, scroll.end > before.scrollTop, `scrollTop ${scroll.start} → ${scroll.end}`)
  check(
    `${label}：是滚过去的（一路经过若干中间位置）而不是一步跳过去`,
    scroll.between.length >= 3,
    `${scroll.frames} 帧里经过 ${scroll.between.length} 个中间位置：${scroll.between.slice(0, 6).join(' → ')}`
  )
  check(
    `${label}：滚起来之后是连续的，没有长时间卡住`,
    scroll.stillDuringMotion <= 6,
    `第 ${scroll.firstMove} 帧动到第 ${scroll.lastMove} 帧，中间有 ${scroll.stillDuringMotion} 帧位置没变`
  )
  check(
    `${label}：等滚到位了才闪（闪过之后亮得够久）`,
    scroll.flashLitFrames >= 12 && scroll.flashAt >= scroll.lastMove - 3,
    `最后一次位移在第 ${scroll.lastMove} 帧，闪现在第 ${scroll.flashAt} 帧，之后 20 帧里亮了 ${scroll.flashLitFrames} 帧（共 ${scroll.frames} 帧）`
  )
  check(`${label}：闪烁动画真的挂上了`, state.animation === 'entry-flash', state.animation)

  // 等它自己摘掉（而不是盲等一段固定时间）：摘早了用户看不见、摘晚了会留成第二个「选中态」
  const gone = await page
    .waitForSelector(flashSelector, { state: 'detached', timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  check(`${label}：闪烁到点自己退场，不留成第二个「选中态」`, gone)
}

/**
 * 「没翻篇就关掉」的端到端复核：不滚也不闪。
 *
 * 要让这条断言有分量，前置条件必须是「旧行为会滚会闪」：详情开着的时候把列表滚走一段，
 * 让刚读的那条落到视口外 —— 若判据还是老的（关掉就定位），它必然滑回去并闪一下。
 * 新判据（useEntryModal 的 navigatedInDetail）下，位置必须停在用户自己滚到的地方。
 */
async function verifyNoNavOnClose(label, closeDetail, flashSelector, shot) {
  await scrollListToTop()
  const opened = await clickFirstItem()
  check(`${label}：点开了一篇`, opened)
  await page.waitForTimeout(1_500)
  const read = await readItemState()
  check(`${label}：前置条件——关掉前刚读的那条在列表里看得见`, read.found && read.visible, read.detail)
  // 前置条件不成立就别往下走了：详情没开时关闭按钮是 disabled，点它会白等 30s 再抛异常
  if (!opened || !read.found) return

  // 详情开着时把列表滚走：不翻篇，只是让刚读的那条离开视口
  await page.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop += 600 })()`)
  await page.waitForTimeout(800)
  const outOfView = await readItemState()
  check(`${label}：前置条件——刚读的那条已被滚出视口（否则证明不了「不滚」）`, !outOfView.visible, outOfView.detail)
  const moved = (await listState()).scrollTop

  await startScrollSampler(flashSelector)
  await closeDetail()
  const flashed = await page
    .waitForSelector(flashSelector, { state: 'attached', timeout: 2_500 })
    .then(() => true)
    .catch(() => false)
  // 标记只挂 1.5s，等不到就等于没闪；再收一遍滚动采样确认位置没动
  const scroll = await stopScrollSampler(1_500)
  check(`${label}：没翻篇直接返回，不再闪一下`, !flashed, flashed ? '仍然闪了' : '')
  check(
    `${label}：列表停在用户自己滚到的位置（没有被拉回去）`,
    Math.abs(scroll.end - moved) <= 4,
    `scrollTop ${moved} → ${scroll.end}（采样 ${scroll.frames} 帧）`
  )
  // 截图留档：详情已退场、列表没动，此刻画面上没有任何闪烁标记
  await page.screenshot({ path: `${OUT}/${shot}-no-nav.png` })
}

await ensureLoggedIn()
await page.goto(`${BASE}/timeline`, { waitUntil: 'domcontentloaded' })
check('时间线加载出条目', await waitForList(SYNC_WAIT_MS))
await page.waitForTimeout(1_000)

// 「列表」视图是唯一会在宽屏拉起常驻阅读栏的版式（见 useReaderPaneMode）
await switchView('列表')
check('宽屏 + 列表视图：阅读栏常驻', (await page.locator(PANE).count()) > 0)

// 「下一篇」要翻得够远才有意义：条目太少的话前置条件（刚读的那篇不在视口里）根本不成立。
// 放在切视图之后：列表视图行高固定 96，渲染条数与「内容有多少屏」都好判。
const ready = await ensureEnoughItems(180_000)
check('列表里铺开的条目足够验证翻页', ready.items >= 8 && ready.scrollHeight >= ready.clientHeight * 2,
  `渲染 ${ready.items} 条，内容 ${ready.scrollHeight}px / 视口 ${ready.clientHeight}px`)

// ── A. 宽屏阅读栏 ──
await scrollListToTop()
const openedA = await clickFirstItem()
check('宽屏阅读栏：点开了一篇', openedA)
await page.waitForTimeout(1_500)
const firstA = await activeTitle()
await pressNext(NEXT_CLICKS)
const movedA = await activeTitle()
check('宽屏阅读栏：连点「下一篇」翻到了别的篇目', !!movedA && movedA !== firstA, `→ ${movedA.slice(0, 24)}`)
await verifyReveal('宽屏阅读栏', async () => {
  await page.locator('[aria-label="关闭阅读栏"]').first().click()
})

// ── D. 没翻篇就关掉：不滚也不闪（仍是宽屏阅读栏，接在 A 后面跑）──
await verifyNoNavOnClose('宽屏阅读栏（没翻篇）', async () => {
  await page.locator('[aria-label="关闭阅读栏"]').first().click()
}, '[data-flash="true"]', 'D')

// ── B. 窄屏弹窗（同一会话，切到手机视口；视图仍是「列表」）──
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(1_200)
await scrollListToTop()
const openedB = await clickFirstItem()
check('窄屏弹窗：点开了一篇', openedB)
await page.waitForTimeout(1_500)
check('窄屏弹窗：阅读栏不再挂载（弹窗与阅读栏互斥）', (await page.locator(PANE).count()) === 0)
const firstB = await activeTitle()
await pressNext(NEXT_CLICKS)
const movedB = await activeTitle()
check('窄屏弹窗：连点「下一篇」翻到了别的篇目', !!movedB && movedB !== firstB, `→ ${movedB.slice(0, 24)}`)
await verifyReveal('窄屏弹窗', async () => {
  await page.locator(`${MODAL} button`, { hasText: '关闭' }).last().click()
})

// ── C. 宽屏 + 表格视图：定位走 UTable 根节点的 scrollTo，标记走 entry-flash 类 ──
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(1_200)
await switchView('表格')
await page.waitForTimeout(1_200)
const tableRows = await page.locator('tbody tr').filter({ has: page.locator('[data-entry-id]') }).count()
check('表格视图：已渲染出行', tableRows >= 8, `已渲染 ${tableRows} 行`)
const tableTop = (await listState()).scrollTop
const openedC = await clickFirstTableRow()
check('表格视图：点开了一篇', openedC)
await page.waitForTimeout(1_500)
const firstC = await activeTitle()
await pressNext(NEXT_CLICKS)
const movedC = await activeTitle()
check('表格视图：连点「下一篇」翻到了别的篇目', !!movedC && movedC !== firstC, `→ ${movedC.slice(0, 24)}`)
// 表格行没有选中高亮（只有已读淡显），前置条件改用「翻页期间列表一寸没动」来钉：
// 行高固定 53，翻 22 行 ≈ 1166px，已经远超一屏
check('表格视图：翻页期间列表没有被推走（刚读的那条在视口外）',
  (await listState()).scrollTop === tableTop, `scrollTop ${tableTop}`)
await verifyReveal('表格视图', closeAnyDetail, 'tr.entry-flash', 'C')

check('无新增 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))

const failed = results.filter(r => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}`)
}

await context.close()
process.exit(failed.length ? 1 : 0)
