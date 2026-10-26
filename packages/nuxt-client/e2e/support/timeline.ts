import type { Page } from 'playwright/test'

/**
 * 时间线列表页的公共操作。
 *
 * 这些逻辑都是从旧的 `scripts/verify-entry-reveal.mjs` 原样搬过来的（选择器、口径与注释
 * 都保持一致），区别只是包装成可复用的函数，让 spec 专注于「验证什么」。
 */

export const PANE = '[aria-label="文章阅读"]'
export const MODAL = '.entry-detail-modal-content'
export const ITEM = '[data-slot="viewport"] > [data-slot="item"]'

/** 首屏全量同步（条目库带图片附件）可能要几分钟：等多久由这个上限决定 */
export const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 1_200_000)
/** 翻多少篇「下一篇」：列表行高 96，翻 22 篇 ≈ 2100px，必然把刚读的那条推出视口 */
export const NEXT_CLICKS = 22

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

export async function ensureLoggedIn(page: Page) {
  // 直接去登录页（和老脚本一致）：冷启动时 Nuxt 首次编译/导航可能超过几秒，
  // 先 goto /timeline 再判断「在不在登录页」会误判成已登录，然后空等列表。
  console.log('  [login] goto /login')
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  console.log(`  [login] 打开登录页完成，url=${page.url()}`)
  const email = page.locator('input[type="email"]')
  const hasForm = await email.first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  console.log(`  [login] 登录表单可见=${hasForm}，url=${page.url()}`)
  // 已登录时 /login 可能直接被送回时间线（没有表单）：此时不用再登录
  if (!hasForm) return

  // 必须等水合完成再提交：首帧表单还没有 @submit.prevent，点下去会走浏览器原生 GET 提交
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(1_500)
  console.log('  [login] 提交表单')
  await page.fill('input[type="email"]', 'admin@example.com', { timeout: 10_000 })
  await page.fill('input[type="password"]', 'Admin123!', { timeout: 10_000 })
  await page.locator('button[type="submit"]').first().click({ timeout: 10_000 })
  await page.waitForURL('**/timeline', { timeout: 20_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  console.log(`  [login] 登录流程结束，url=${page.url()}`)
}

/** 等时间线列表真正渲染出条目（首次进入要先做一轮 PouchDB 同步，可能很慢） */
export async function waitForList(page: Page, timeout: number) {
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
    if (elapsed % 15 < 6) {
      // 带上 URL 与首屏文字：冷启动卡住时能一眼看出是「没登录」还是「同步没开始」
      const tail = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '')
      console.log(`  …等待首屏同步 ${elapsed}s（查看 ×${applies}，url=${page.url()}，body=${tail}）`)
    }
  }
  return false
}

/**
 * 切视图（菜单项名与 LIST_VIEW_META 的 label 一致）；已经是目标视图就不动。
 *
 * 下拉菜单的打开在页面刚导航完 / 首屏还在渲染时可能失败一次（点了但菜单还没挂载），
 * 所以这里重试「打开菜单 → 等菜单项出现」，而不是点一次就等超时。
 */
export async function ensureListView(page: Page, label: string) {
  const switcher = page.locator('[aria-label^="切换视图"]')
  await switcher.first().waitFor({ state: 'visible', timeout: 15_000 })
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await switcher.first().getAttribute('aria-label') ?? ''
    if (current.includes(`当前：${label}`)) return
    await switcher.first().click({ timeout: 5_000 }).catch(() => {})
    const item = page.getByRole('menuitemcheckbox', { name: label })
    const opened = await item.waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true).catch(() => false)
    if (!opened) {
      await page.waitForTimeout(500)
      continue
    }
    await item.click({ timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(1_200)
    return
  }
  throw new Error(`切换视图失败：菜单项「${label}」始终没有出现`)
}

/** 列表的滚动容器：离条目最近的那个可滚动祖先（与页面自己定位滚动容器的口径一致） */
const SCROLLER = `(() => {
  let el = document.querySelector('[data-entry-id]')?.parentElement ?? null
  while (el && !(el.scrollHeight > el.clientHeight + 20)) el = el.parentElement
  return el
})()`

export interface ListState {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  items: number
}

export async function listState(page: Page): Promise<ListState> {
  return page.evaluate(`(() => {
    const el = ${SCROLLER}
    return {
      scrollTop: Math.round(el?.scrollTop ?? -1),
      clientHeight: Math.round(el?.clientHeight ?? 0),
      scrollHeight: Math.round(el?.scrollHeight ?? 0),
      items: document.querySelectorAll('[data-entry-id]').length
    }
  })()`) as Promise<ListState>
}

export async function scrollListToTop(page: Page) {
  await page.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop = 0 })()`)
  await page.waitForTimeout(600)
}

/** 把列表滚动一段距离（详情开着时滚走刚读的那条，用于验证「不定位」） */
export async function scrollListBy(page: Page, delta: number) {
  await page.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop += ${delta} })()`)
  await page.waitForTimeout(800)
}

/**
 * 等同步彻底空闲：没有「正在同步」进度，也没有「已同步 N 条 查看」提示条。
 *
 * 冷 profile 的首次全量同步、以及测试期间后台抓到的新条目，都会在列表上方插一条提示条
 * （点「查看」才把新条目放进列表）。提示条出现的瞬间行会整体下移，点行/量位置的断言就会
 * 落到错的行或落空 —— 所以每个依赖「列表此刻是稳定的」用例开始前都先等它空闲。
 * 有「查看」就顺手点掉，避免它一直压着列表。
 */
export async function waitForSyncIdle(page: Page, timeout = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const syncing = await page.evaluate(() => /正在同步/.test(document.body.innerText)).catch(() => true)
    const apply = page.getByRole('button', { name: '查看' })
    const pending = (await apply.count()) > 0 && await apply.first().isVisible().catch(() => false)
    if (!syncing && !pending) return true
    if (pending) await apply.first().click({ timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(2_000)
  }
  return false
}

/**
 * 列表里铺开的内容够不够验证翻页。
 *
 * 首次同步还在进行时，本地库里的条目是分批到的：新到的那批折叠进「已同步 N 条」提示条，
 * 点「查看」才上屏。这里点到「列表至少有两屏」为止 —— 条目太少的话，连点「下一篇」根本
 * 推不出视口，验证的前提（刚读的那篇在视口外）就不成立了。
 */
export async function ensureEnoughItems(page: Page, timeout: number): Promise<ListState> {
  const start = Date.now()
  let state = await listState(page)
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
      await scrollListToTop(page)
    }
    state = await listState(page)
  }
  return state
}

export interface ItemState {
  found: boolean
  id?: string
  visible: boolean
  detail: string
}

/**
 * 「正在读的那一条」在列表里的状态。
 *
 * 认选中高亮（列表行的 `bg-primary/10`，见 EntryRowItem 的 selected）而不是标题：
 * 高亮是列表自己标的，id 也一并拿得到，而标题比较容易被截断 / 空白差异带偏。
 * 找不到高亮行 = 虚拟化根本没渲染它 = 它在视口外，这本身就是「要往下翻很久」的成因。
 */
export async function readItemState(page: Page): Promise<ItemState> {
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
      id: el.getAttribute('data-entry-id') ?? undefined,
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      detail: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`
    }
  }) as Promise<ItemState>
}

/**
 * 当前展示面上那篇的标题（宽屏是阅读栏，窄屏是弹窗的活动槽）。
 *
 * 要排掉正在淡出的那一层：切篇是交叉淡入淡出（见 EntryDetailModal 的 .entry-fade），
 * 退场的那篇此刻仍在 DOM 里并且排在前面，直接取第一个 h1 会读到上一篇。
 */
export async function activeTitle(page: Page): Promise<string> {
  return page.evaluate(({ pane, modal }) => {
    const scope = document.querySelector('.swiper-slide-active')
      ?? document.querySelector(modal)
      ?? document.querySelector(pane)
    if (!scope) return ''
    const live = [...scope.querySelectorAll('h1')].filter(el => !el.closest('.entry-fade-leave-active'))
    return (live.at(-1)?.textContent ?? '').trim()
  }, { pane: PANE, modal: MODAL })
}

export interface FlashState {
  found: boolean
  id?: string
  matched?: boolean
  visible?: boolean
  geometry?: string
  animation?: string
  scrollTop?: number
}

/**
 * 刚闪的那条：位置、动画、以及它是不是用户刚读的那篇（标记只挂 1.5s，要趁早问）。
 *
 * `flashSelector` 随视图不同：滚动区的条目挂 data-flash（子组件根节点透传），
 * 表格的行由 UTable 生成、挂不了自定义属性，只能加 entry-flash 类。
 * 认「行文本里含标题开头」而不是只找 h3 —— 表格行里没有 h3，标题只是普通文本节点。
 */
export async function flashState(page: Page, title: string, flashSelector: string): Promise<FlashState> {
  return page.evaluate(({ want, selector }) => {
    const norm = (s: string | null) => (s ?? '').replace(/\s+/g, '')
    const el = document.querySelector(selector)
    if (!el) return { found: false }
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
    const box = scroller?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      found: true,
      id: el.getAttribute('data-entry-id') ?? el.querySelector('[data-entry-id]')?.getAttribute('data-entry-id') ?? undefined,
      matched: norm(el.textContent).includes(norm(want).slice(0, 30)),
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      geometry: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`,
      animation: style.animationName,
      scrollTop: Math.round(scroller?.scrollTop ?? -1)
    }
  }, { want: title, selector: flashSelector }) as Promise<FlashState>
}

/** 某条（按 id 认）此刻在列表里的位置 —— 闪的标记已经摘掉之后，靠它复核最终落点 */
export async function entryState(page: Page, id: string): Promise<ItemState> {
  return page.evaluate((want) => {
    const cell = [...document.querySelectorAll('[data-entry-id]')]
      .find(node => node.getAttribute('data-entry-id') === want)
    // 表格里 data-entry-id 在来源格上，要定位的是它所在的 tr（同 EntryList 的 revealElement）
    const el = cell?.closest('tr') ?? cell
    if (!el) return { found: false, visible: false, detail: '定位之后列表里仍没有这一条的节点' }
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20)) scroller = scroller.parentElement
    const box = scroller?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return {
      found: true,
      visible: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
      detail: `条目 ${Math.round(r.top)}~${Math.round(r.bottom)} / 视口 ${Math.round(box?.top ?? 0)}~${Math.round(box?.bottom ?? 0)}`
    }
  }, id) as Promise<ItemState>
}

/**
 * 起一个逐帧采样器，量「关掉详情之后滚动位置是怎么变的」。
 *
 * 平滑滚动会经过一串中间位置，而 `scrollTop = 目标值` 这种一步到位的写法只会有首尾两个值；
 * 采样必须逐帧（60fps），隔几十毫秒去问一次已经跟不上动画了。
 */
export async function startScrollSampler(page: Page, flashSelector: string) {
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

export interface ScrollSample {
  start: number
  end: number
  between: number[]
  frames: number
  firstMove: number
  lastMove: number
  stillDuringMotion: number
  flashAt: number
  flashLitFrames: number
}

/** 等到滚动停稳（连续几帧同一个值），再收走采样结果 */
export async function stopScrollSampler(page: Page, budgetMs = 3_000): Promise<ScrollSample> {
  const deadline = Date.now() + budgetMs
  let last: number | null = null
  let stable = 0
  while (Date.now() < deadline) {
    const current = await page.evaluate('window.__reveal?.samples?.at(-1)?.top ?? -1') as number
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
    return { start: first, end, between, frames: samples.length, firstMove, lastMove, stillDuringMotion, flashAt, flashLitFrames }
  })()`) as Promise<ScrollSample>
}

/** 点列表里视口内的第一个条目（不让 Playwright 自己滚动，滚动位置前后对比才有意义） */
export async function clickFirstItem(page: Page) {
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
export async function clickFirstTableRow(page: Page) {
  const rows = page.locator('tbody tr').filter({ has: page.locator('[data-entry-id]') })
  const count = await rows.count()
  let tried = 0
  for (let i = 0; i < count && tried < 4; i++) {
    const box = await rows.nth(i).boundingBox().catch(() => null)
    // 顶部 120px 留给「已同步 N 条」提示条与表头，底部留一点余量
    if (!box || box.y < 120 || box.y + box.height > (page.viewportSize()?.height ?? 900) - 60) continue
    tried += 1
    const strategies: Array<[string, () => Promise<void>]> = [
      // 标题格（第一格是来源，语义不一定「读这篇」）
      ['td', async () => { await rows.nth(i).locator('td').nth(1).click({ timeout: 2_500 }) }],
      ['row', async () => { await rows.nth(i).click({ timeout: 2_500 }) }],
      // 行里可能被提示条/虚拟化重渲染短暂遮住：坐标点更接近真实操作
      ['mouse', async () => {
        const b = await rows.nth(i).boundingBox()
        if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
      }],
      // 兜底：行是 role=button + tabindex，Enter 由 UTable 根上的 handler 代理 ——
      // 指针被看不见的遮罩/锁挡住时，键盘仍然能打开（真实用户也能这样操作）
      ['keyboard', async () => {
        await rows.nth(i).focus()
        await page.keyboard.press('Enter')
      }]
    ]
    for (const [name, act] of strategies) {
      await act().catch(() => {})
      const opened = await page.locator(`${MODAL} h1`).first()
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true).catch(() => false)
      const routed = page.url().includes('/entry/')
      console.log(`  [table] row#${i} 试 ${name}：弹窗=${opened}（url=${page.url().replace(/^https?:\/\/[^/]+/, '')}）`)
      if (opened || routed) return true
      // 若这次点击误开了别的东西，按 Esc 收回去再试下一种
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)
    }
  }
  return false
}

/** 关掉当前展示面：阅读栏挂的是 X，弹窗挂的是「关闭」——两个展示面互斥，按谁在就用谁 */
export async function closeAnyDetail(page: Page) {
  const paneClose = page.locator('[aria-label="关闭阅读栏"]')
  if ((await paneClose.count()) > 0) {
    await paneClose.first().click()
    return
  }
  await page.locator(`${MODAL} button`, { hasText: '关闭' }).last().click()
}

/** 连点「下一篇」：宽屏用键盘（阅读栏与弹窗都监听 ←/→），窄屏弹窗底部浮钮不渲染，同样走键盘 */
export async function pressNext(page: Page, times: number) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(90)
  }
}

/**
 * 每个用例开始前把页面复位成「宽屏 + 列表视图 + 顶部 + 详情已关闭」。
 *
 * 用例之间共享同一个页面与持久化 profile（省一次登录 + 全量同步），所以复位必须显式做，
 * 不能指望上一个用例留下的状态。
 */
export async function resetToList(page: Page) {
  // 详情可能还开着（上一个用例失败时尤其常见）：先按展示面关掉。
  // 注意关闭按钮在「没选中条目」时是 disabled 的，直接 click 会白等满一个用例超时，
  // 所以先判 enabled，并且所有动作都给短超时。
  const paneClose = page.locator('[aria-label="关闭阅读栏"]')
  if ((await paneClose.count()) > 0 && await paneClose.first().isEnabled().catch(() => false)) {
    await paneClose.first().click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
  const modalClose = page.locator(`${MODAL} button`, { hasText: '关闭' }).last()
  if ((await modalClose.count()) > 0 && await modalClose.isEnabled().catch(() => false)) {
    await modalClose.click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
  // 切回宽屏（上一个用例可能停在窄屏）
  if ((page.viewportSize()?.width ?? 1440) !== 1440) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(1_200)
  }
  await ensureListView(page, '列表')
  await scrollListToTop(page)
}
