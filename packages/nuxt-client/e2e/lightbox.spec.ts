import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright/test'
import { REPO_ROOT } from './support/playwright-env.mjs'
import { expect, test } from './fixtures'
import {
  ensureListView,
  ensureLoggedIn,
  SYNC_WAIT_MS,
  waitForList,
  waitForSyncIdle
} from './support/timeline'

/**
 * 图片放大（vue-easy-lightbox）端到端验证（从 scripts/verify-lightbox.mjs 迁到 Playwright Test）。
 *
 * 覆盖 4 件事：
 *   1. 点击放大     —— 点正文图片后 lightbox 打开，且展示的正是被点的那张（含换一张点、index 传递）
 *   2. 滚轮缩放     —— 滚轮后 .vel-img-wrapper 的 scale 变大/变小（vue-easy-lightbox 把缩放放在
 *                      wrapper 的 transform 上）
 *   3. 嵌套模态框   —— lightbox 从 body teleport，点它自己的按钮不能让条目弹窗（UModal）跟着关掉
 *   4. 暗色         —— 暗色主题下遮罩/图片/工具栏仍然正常
 *
 * 另外顺带验证 useEntryContent 的图片替换（远程 URL -> 本地 blob）与 attach 时机，
 * 以及 ESC 只关 lightbox、不关条目弹窗。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态与本地 PouchDB 存在
 * playwright.config.ts 指定的持久化 profile 里，第二次之后很快）。
 *
 * 与旧脚本的差异：旧脚本为每个主题新开 `browser.newContext()`（每次空 IndexedDB，冷同步会超过
 * 它自己的 90s 等待而上限而必挂）。这里复用 Playwright Test 的持久化 context，只把「色彩模式」
 * 用 localStorage 的 `nuxt-color-mode` + reload 切过去；其余断言口径不变。
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT_DIR = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/lightbox')
const VIEWPORT = { width: 1440, height: 900 }

/** 有界浏览器侧的 console 错误 / 未捕获异常 / 请求失败（旧脚本只打印，这里也不把第三方噪音判成失败） */
interface Noise { consoleErrors: string[], pageErrors: string[], failedRequests: string[], httpErrors: string[] }

function watchNoise(page: Page, noise: Noise) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') noise.consoleErrors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', err => noise.pageErrors.push(String(err).slice(0, 300)))
  page.on('requestfailed', (req) => {
    if (req.url().includes('favicon')) return
    noise.failedRequests.push(`${req.method()} ${req.url().slice(0, 160)} — ${req.failure()?.errorText}`)
  })
  page.on('response', (res) => {
    if (res.status() < 400 || res.url().includes('favicon')) return
    noise.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 170)}`)
  })
}

/** 切色彩模式：@nuxtjs/color-mode 从 localStorage 的 nuxt-color-mode 读偏好 */
async function ensureColorMode(page: Page, theme: 'light' | 'dark') {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(t => localStorage.setItem('nuxt-color-mode', t), theme)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  return page.evaluate(() => document.documentElement.classList.contains('dark'))
}

/**
 * 打开第一个带「可放大图片」的条目。
 *
 * 列表里并非每篇正文都有图，所以按卡片顺序试；每试一篇都等 useEntryContent 管线跑完
 * —— attach 完成的可靠标志是图片被加上 cursor: zoom-in（见 useImageLightbox.attach）。
 */
async function openEntryWithImage(page: Page, maxTries = 12) {
  const cards = page.locator('.cursor-pointer')
  const total = await cards.count()
  const tries = Math.min(total, maxTries)

  for (let i = 0; i < tries; i++) {
    const card = cards.nth(i)
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click({ timeout: 15_000 }).catch(() => {})

    const appeared = await page
      .waitForSelector('.swiper-slide-active .entry-content, .entry-content', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (!appeared) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      continue
    }

    await page.waitForTimeout(400)
    // 快路径：正文里压根没图就别等 attach 超时了
    const imgCount = await page.evaluate(() => {
      const scope: ParentNode = document.querySelector('.swiper-slide-active') ?? document
      return scope.querySelectorAll('.entry-content img').length
    })
    if (imgCount > 0) {
      const attached = await page
        .waitForFunction(() => {
          const scope: ParentNode = document.querySelector('.swiper-slide-active') ?? document
          return Array.from(scope.querySelectorAll('.entry-content img'))
            .some(img => (img as HTMLElement).style.cursor === 'zoom-in')
        }, null, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (attached) return { index: i, attempts: i + 1, imgCount }
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  return { index: -1, attempts: tries }
}

interface Candidate { idx: number, src: string, srcAttr: string, currentSrc: string, isBlob: boolean, alt: string }

/**
 * 列出当前弹窗里所有「已 attach 且在视口内」的图，附 src 与点击坐标。
 * 返回数组而不是单张，调用方才能「换一张再点」来验证 index 传得对不对。
 */
async function listZoomable(page: Page): Promise<Candidate[]> {
  return page.evaluate(() => {
    const inViewport = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
    }
    // Swiper 三槽模式会同时渲染相邻条目，必须只看活动 slide，否则会选到
    // 上一篇/下一篇的图片——点它等于点到视口外，会把条目弹窗一起关掉
    const scope: ParentNode = document.querySelector('.swiper-slide-active') ?? document
    const out: Candidate[] = []
    for (const img of scope.querySelectorAll('.entry-content img')) {
      if ((img as HTMLElement).style.cursor !== 'zoom-in' || !inViewport(img)) continue
      const srcAttr = img.getAttribute('src') || ''
      const currentSrc = (img as HTMLImageElement).currentSrc || ''
      // 打标记后用 locator 点击：自己算坐标在「图片只有一部分在视口内」时会点偏，
      // 让 Playwright 负责滚动与取中心点
      img.setAttribute('data-verify-cand', String(out.length))
      out.push({
        idx: out.length,
        src: currentSrc || srcAttr,
        srcAttr,
        currentSrc,
        isBlob: srcAttr.startsWith('blob:'),
        alt: img.getAttribute('alt') || ''
      })
    }
    return out
  }) as Promise<Candidate[]>
}

/** 挑一张来点：优先 blob（附件已缓存、必定加载成功，滚轮缩放才走得通），否则第一张 */
function chooseZoomable(candidates: Candidate[]) {
  return candidates.find(c => c.isBlob) ?? candidates[0] ?? null
}

/**
 * 展示的地址是否属于这张图。
 *
 * 同一张图会有两个地址：原始的远程 URL（src 属性被替换前的值，可能还留在 currentSrc 里）
 * 和替换后的 blob。正文的 img.src 一设置，浏览器要过一会儿才更新 currentSrc，attach 与
 * 断言读到的时刻不同就会各读到一个，所以按「集合」判定，而不是要求字符串相等。
 */
function matchesCandidate(shownSrc: string | undefined, cand: Candidate) {
  if (!shownSrc) return false
  return [cand.src, cand.srcAttr, cand.currentSrc].filter(Boolean).includes(shownSrc)
}

const short = (s?: string) => (s || '').slice(0, 46)

/** 读取 lightbox wrapper 上的 scale（组件把 transform: translate(-50%,-50%) scale(x) 写在这里） */
async function readScale(page: Page) {
  return page.evaluate(() => {
    // 多图时每个 slide 各有一个 wrapper，必须取活动的那一个
    const el = (document.querySelector('.swiper-slide-active .vel-img-wrapper')
      ?? document.querySelector('.vel-img-wrapper')) as HTMLElement | null
    if (!el) return null
    const m = /scale\(([\d.]+)\)/.exec(el.style.transform || '')
    return m ? Number(m[1]) : null
  })
}

/**
 * lightbox 当前展示的那张图。
 *
 * 多图时组件用 swiper 渲染，DOM 里同时存在相邻预加载的 .vel-img，
 * 直接 querySelector('.vel-img') 会读到相邻那张、得出「点 A 显示 B」的假象，
 * 所以必须认活动 slide。
 */
async function currentImageState(page: Page) {
  return page.evaluate(() => {
    const img = (document.querySelector('.swiper-slide-active .vel-img')
      ?? document.querySelector('.vel-img')) as HTMLImageElement | null
    if (!img) return { found: false, src: '', naturalWidth: 0, complete: false }
    return {
      found: true,
      src: img.currentSrc || img.src || '',
      naturalWidth: img.naturalWidth,
      complete: img.complete
    }
  }) as Promise<{ found: boolean, src: string, naturalWidth: number, complete: boolean }>
}

/** 条目弹窗是否还开着（正文仍在且可见） */
async function entryModalOpen(page: Page) {
  return page.evaluate(() => {
    const scope: ParentNode = document.querySelector('.swiper-slide-active') ?? document
    const el = scope.querySelector('.entry-content') as HTMLElement | null
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

async function collectStyle(page: Page) {
  return page.evaluate(() => {
    const modal = document.querySelector('.vel-modal') as HTMLElement | null
    if (!modal) return null
    const cs = getComputedStyle(modal)
    const img = document.querySelector('.vel-img') as HTMLImageElement | null
    return {
      background: cs.backgroundColor,
      backdropFilter: cs.backdropFilter,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      hasDismissableLayer: modal.hasAttribute('data-dismissable-layer'),
      imgBackground: img ? getComputedStyle(img).backgroundColor : null,
      htmlDark: document.documentElement.classList.contains('dark')
    }
  }) as Promise<StyleState | null>
}

/** 一个主题下的完整验证流程（断言用 expect.soft，一次运行拿完整失败清单） */
async function runTheme(page: Page, theme: 'light' | 'dark') {
  test.setTimeout(240_000)
  const noise: Noise = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] }
  watchNoise(page, noise)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const isDarkAtStart = await ensureColorMode(page, theme)
  await page.goto(`${BASE}/timeline`, { waitUntil: 'domcontentloaded' })
  expect(await waitForList(page, SYNC_WAIT_MS), `[${theme}] 时间线加载出条目`).toBe(true)
  // 用瀑布流（弹窗）走，保证断言的是 UModal + lightbox 这一层，而不是宽屏阅读栏
  await ensureListView(page, '瀑布流')
  await waitForSyncIdle(page)
  await page.waitForTimeout(800)

  const opened = await openEntryWithImage(page)
  expect.soft(opened.index >= 0, `[${theme}] 找到带图条目并完成 attach（试了 ${opened.attempts} 篇）`).toBe(true)
  if (opened.index < 0) {
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-no-image.png`) })
    fs.writeFileSync(path.join(OUT_DIR, `${theme}-noise.json`), JSON.stringify(noise, null, 2))
    return
  }
  console.log(`[${theme}] 第 ${opened.attempts} 篇，卡片 #${opened.index}，正文图 ${opened.imgCount} 张`)

  const candidates = await listZoomable(page)
  const pick = chooseZoomable(candidates)
  expect.soft(!!pick, `[${theme}] 定位到可放大图片`).toBe(true)
  if (!pick) {
    fs.writeFileSync(path.join(OUT_DIR, `${theme}-noise.json`), JSON.stringify(noise, null, 2))
    return
  }
  // 图片是否已缓存为附件取决于该篇同步没同步完，没命中就退回远程图，放大功能一样成立：只提示
  console.log(`${pick.isBlob ? '[ok]' : '[!]'} [${theme}] 正文图片地址 ${pick.isBlob ? '已换成本地 blob' : '仍是远程 URL（该篇附件未缓存）'} — ${pick.src.slice(0, 60)}`)
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-1-entry-modal.png`) })

  // ── 1. 点击放大 ──────────────────────────────────────────────
  await page.locator(`[data-verify-cand="${pick.idx}"]`).click()
  const openedLightbox = await page.waitForSelector('.vel-modal', { state: 'visible', timeout: 8_000 })
    .then(() => true).catch(() => false)
  expect.soft(openedLightbox, `[${theme}] 点击图片打开 lightbox`).toBe(true)
  if (!openedLightbox) {
    fs.writeFileSync(path.join(OUT_DIR, `${theme}-noise.json`), JSON.stringify(noise, null, 2))
    return
  }
  await page.waitForTimeout(900) // 等 lightbox 内图片加载

  const shown = await currentImageState(page)
  const state = await collectStyle(page)
  expect.soft(
    shown.found && matchesCandidate(shown.src, pick),
    `[${theme}] lightbox 展示的正是被点的那张图（展示=${short(shown.src)} | 被点=${short(pick.srcAttr)} currentSrc=${short(pick.currentSrc)}）`
  ).toBe(true)
  expect.soft(state?.pointerEvents === 'auto', `[${theme}] 遮罩收回了 pointer-events（父级 UModal 会把 body 设为 none，实际 ${state?.pointerEvents}）`).toBe(true)
  expect.soft(
    state?.background === 'rgba(0, 0, 0, 0.62)',
    `[${theme}] 遮罩背景被定制过（非组件默认 rgba(0,0,0,.5)，实际 ${state?.background}, blur=${state?.backdropFilter}）`
  ).toBe(true)
  expect.soft(state?.hasDismissableLayer === true, `[${theme}] .vel-modal 被标记为 dismissable-layer`).toBe(true)
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-2-lightbox-open.png`) })

  // ── 1b. index 传递：换一张图点，lightbox 必须跟着换 ──────────────
  // 只点一张时，即使 index 根本没生效、永远打开第 0 张，看起来也一样「正确」。
  const other = candidates.find(c => c.src !== pick.src)
  if (other) {
    await page.keyboard.press('Escape')
    // 必须等遮罩彻底消失：淡出中的遮罩会吞掉点击，此时它已卸掉 data-dismissable-layer，
    // UModal 会把这次点击当成外部点击把弹窗关掉
    await page.waitForSelector('.vel-modal', { state: 'detached', timeout: 6_000 }).catch(() => {})
    await page.waitForTimeout(300)
    await page.locator(`[data-verify-cand="${other.idx}"]`).click()
    const reopened = await page.waitForSelector('.vel-modal', { state: 'visible', timeout: 8_000 })
      .then(() => true).catch(() => false)
    await page.waitForTimeout(900)
    const shownOther = reopened ? await currentImageState(page) : { found: false, src: '' }
    expect.soft(
      matchesCandidate(shownOther.src, other) && !matchesCandidate(shownOther.src, pick),
      `[${theme}] 换一张图点，lightbox 跟着换（点了=${short(other.srcAttr)} 显示=${short(shownOther.src)}）`
    ).toBe(true)
  } else {
    console.log(`[!] [${theme}] 视口内只有一张图，跳过 index 传递检查`)
  }

  // ── 2. 滚轮缩放 ──────────────────────────────────────────────
  const scaleBefore = await readScale(page)
  const imgReady = shown.naturalWidth > 0
  expect.soft(imgReady, `[${theme}] lightbox 图片加载成功（缩放可用的前提，naturalWidth=${shown.naturalWidth}）`).toBe(true)
  if (imgReady) {
    const modalBox = await page.locator('.vel-modal').boundingBox()
    await page.mouse.move(
      (modalBox?.x ?? 0) + (modalBox?.width ?? VIEWPORT.width) / 2,
      (modalBox?.y ?? 0) + (modalBox?.height ?? VIEWPORT.height) / 2
    )
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(200) // 组件内部有 80ms 滚轮节流
    }
    await page.waitForTimeout(300)
    const scaleAfter = await readScale(page)
    expect.soft(
      scaleBefore !== null && scaleAfter !== null && scaleAfter > scaleBefore,
      `[${theme}] 滚轮向上放大（scale ${scaleBefore} -> ${scaleAfter}）`
    ).toBe(true)

    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 240)
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(300)
    const scaleZoomOut = await readScale(page)
    expect.soft(
      scaleZoomOut !== null && scaleAfter !== null && scaleZoomOut < scaleAfter,
      `[${theme}] 滚轮向下缩小（scale ${scaleAfter} -> ${scaleZoomOut}）`
    ).toBe(true)
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-3-zoom.png`) })
  }

  // ── 2b. 多图切换（替换 medium-zoom 的主要收益）────────────────
  const beforeSwitch = await currentImageState(page)
  let switchedTo = ''
  for (const sel of ['.btn__next', '.btn__prev']) {
    const btn = page.locator(`.vel-btns-wrapper ${sel}`)
    if (await btn.count() === 0) continue
    await btn.first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)
    const afterSwitch = await currentImageState(page)
    if (afterSwitch.src && afterSwitch.src !== beforeSwitch.src) {
      switchedTo = afterSwitch.src
      break
    }
  }
  if (switchedTo) {
    expect.soft(true, `[${theme}] 多图能切到另一张（${short(beforeSwitch.src)} -> ${short(switchedTo)}）`).toBe(true)
    expect.soft(await entryModalOpen(page), `[${theme}] 翻页后条目弹窗仍在`).toBe(true)
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-3b-next-image.png`) })
  } else {
    console.log(`[!] [${theme}] 没有可切换的相邻图（本篇只有一张），跳过翻页检查`)
  }

  // ── 3. 嵌套 UModal：点 lightbox 自己的按钮不能关掉条目弹窗 ────────
  const modalBefore = await entryModalOpen(page)
  const toolbarBtn = page.locator('.vel-toolbar .toolbar-btn').first()
  if (await toolbarBtn.count() > 0) {
    await toolbarBtn.click({ force: true }).catch(() => {})
  } else {
    await page.mouse.click(30, 30)
  }
  await page.waitForTimeout(700)
  const modalAfter = await entryModalOpen(page)
  const lightboxStill = await page.locator('.vel-modal').isVisible().catch(() => false)
  expect.soft(
    modalBefore && modalAfter,
    `[${theme}] 点 lightbox 内部按钮不会关掉条目弹窗（弹窗 before=${modalBefore} after=${modalAfter}，lightbox 仍打开=${lightboxStill}）`
  ).toBe(true)
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-4-after-toolbar-click.png`) })

  // ── ESC：只关 lightbox ───────────────────────────────────────
  if (!lightboxStill) {
    await page.locator(`[data-verify-cand="${pick.idx}"]`).click().catch(() => {})
    await page.waitForSelector('.vel-modal', { state: 'visible', timeout: 8_000 }).catch(() => {})
    await page.waitForTimeout(700)
  }
  const beforeEsc = await page.locator('.vel-modal').isVisible().catch(() => false)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const afterEsc = await page.locator('.vel-modal').isVisible().catch(() => false)
  const modalAfterEsc = await entryModalOpen(page)
  expect.soft(
    beforeEsc && !afterEsc && modalAfterEsc,
    `[${theme}] ESC 关掉 lightbox 但保留条目弹窗（lightbox ${beforeEsc} -> ${afterEsc}，条目弹窗仍在=${modalAfterEsc}）`
  ).toBe(true)

  // ── 4. 主题相关 ─────────────────────────────────────────────
  if (theme === 'dark') {
    expect.soft(
      isDarkAtStart && await page.evaluate(() => document.documentElement.classList.contains('dark')),
      `[${theme}] 页面确实进入暗色模式（html.dark）`
    ).toBe(true)
  }

  console.log(`[${theme}] 控制台/网络噪音：console=${noise.consoleErrors.length} pageerror=${noise.pageErrors.length} requestFailed=${noise.failedRequests.length} http4xx5xx=${noise.httpErrors.length}`)
  fs.writeFileSync(path.join(OUT_DIR, `${theme}-noise.json`), JSON.stringify(noise, null, 2))
}

test.describe.configure({ mode: 'serial' })

test.describe('图片放大（vue-easy-lightbox）', () => {
  test.beforeAll(async ({ appPage, jsErrors }) => {
    test.setTimeout(SYNC_WAIT_MS + 120_000)
    jsErrors.length = 0
    await ensureLoggedIn(appPage)
    // 固定成瀑布流（弹窗）走，避免 profile 里残留的默认视图把正文放进宽屏阅读栏
    await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
    await appPage.waitForTimeout(1_500)
    await appPage.evaluate(() => localStorage.setItem('app-settings', JSON.stringify({
      entryModalSize: 'sm:max-w-6xl',
      fixedBars: true,
      view: 'masonry'
    })))
  })

  test('亮色主题：点击放大 / 滚轮缩放 / 嵌套模态框', async ({ appPage }) => {
    await runTheme(appPage, 'light')
  })

  test('暗色主题：遮罩与图片仍然正常', async ({ appPage }) => {
    await runTheme(appPage, 'dark')
  })

  test('复原设置且无新增 JS 错误', async ({ appPage, jsErrors }) => {
    await appPage.evaluate(() => {
      localStorage.removeItem('app-settings')
      localStorage.setItem('nuxt-color-mode', 'system')
    }).catch(() => {})
    expect.soft(jsErrors.slice(0, 3), jsErrors.slice(0, 3).join(' | ')).toEqual([])
  })
})
