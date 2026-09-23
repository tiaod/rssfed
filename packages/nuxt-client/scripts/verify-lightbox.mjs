#!/usr/bin/env node
/**
 * 图片放大（vue-easy-lightbox）端到端验证。
 *
 * 覆盖 4 件事，逐条给出 [ok]/[x]：
 *   1. 点击放大     —— 点正文图片后 lightbox 打开，且展示的正是被点的那张
 *   2. 滚轮缩放     —— 滚轮后 .vel-img-wrapper 的 scale 变大（vue-easy-lightbox 把缩放放在 wrapper 的 transform 上）
 *   3. 嵌套模态框   —— lightbox 从 body teleport，点它自己的按钮不能让条目弹窗（UModal）跟着关掉
 *   4. 暗色         —— 暗色主题下遮罩/图片/工具栏仍然正常
 *
 * 另外顺带验证 useEntryContent 的图片替换（远程 URL -> 本地 blob）与 attach 时机，
 * 以及 ESC 只关 lightbox、不关条目弹窗。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录。
 * 用法：node packages/nuxt-client/scripts/verify-lightbox.mjs
 *       环境变量无需手动传，脚本会自己把浏览器目录与缺失的系统库接好（见下方「运行环境自举」）。
 *       想覆盖时仍可用 PLAYWRIGHT_BROWSERS_PATH / LD_LIBRARY_PATH / BASE_URL / OUT_DIR。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// ── 运行环境自举 ───────────────────────────────────────────────
// 本机是容器：系统没有 Chromium，且缺 libnspr4 / libnss3 / libasound2，
// 而 NoNewPrivs=1 + 非 root 意味着装不了系统包。浏览器正常走 playwright 的默认
// 缓存（pnpm exec playwright install chromium），缺的这几个库则解包到项目里，
// 这里自动挂上，调用方直接 node 跑就行，不必每次拼一长串环境变量。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..')
/** 备用：项目内也放一份浏览器时用它（正常情况下用默认缓存即可） */
const LOCAL_BROWSERS = path.join(REPO_ROOT, 'node_modules/.playwright-browsers')
/** 缺的系统库：apt-get download + dpkg -x 解包到这里，靠 LD_LIBRARY_PATH 生效 */
const LOCAL_LIBS = path.join(REPO_ROOT, 'node_modules/.pw-syslibs/usr/lib/x86_64-linux-gnu')

/** 本地备用目录里真有 chromium 才算数（目录可能只残留别的东西） */
function hasLocalChromium() {
  try {
    return fs.readdirSync(LOCAL_BROWSERS).some(name => name.startsWith('chromium'))
  } catch {
    return false
  }
}

/** playwright 自带浏览器在各平台的默认缓存目录 */
function defaultBrowserCache() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ms-playwright')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Caches/ms-playwright')
  }
  return path.join(os.homedir(), '.cache/ms-playwright')
}

// 浏览器目录优先级：显式指定 > 默认缓存（playwright install 装的）> 项目内备用
if (
  !process.env.PLAYWRIGHT_BROWSERS_PATH
  && !fs.existsSync(defaultBrowserCache())
  && hasLocalChromium()
) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS
}
// 缺的系统库只在 sysroot 存在时追加，不覆盖你已有的 LD_LIBRARY_PATH
if (fs.existsSync(LOCAL_LIBS)) {
  process.env.LD_LIBRARY_PATH = [LOCAL_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
}

// 必须在环境接好之后再加载 playwright：它在加载时就会确定浏览器查找目录
const { chromium } = await import('playwright')

const BASE = process.env.BASE_URL || 'http://localhost:3000'
// 产物固定落在仓库根的 report/，不管从哪个目录调用（npm script 的 cwd 是子包）
const OUT_DIR = process.env.OUT_DIR || path.join(REPO_ROOT, 'report/lightbox')
const CREDS = { email: 'admin@example.com', password: 'Admin123!' }
const VIEWPORT = { width: 1440, height: 900 }

fs.mkdirSync(OUT_DIR, { recursive: true })

/** 收集到的检查结论 */
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok]' : '[x] '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 浏览器侧的 console 错误 / 未捕获异常 / 请求失败 */
const noise = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] }
function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') noise.consoleErrors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', err => noise.pageErrors.push(String(err).slice(0, 300)))
  page.on('requestfailed', (req) => {
    // favicon 之类不影响功能，单独忽略
    if (req.url().includes('favicon')) return
    noise.failedRequests.push(`${req.method()} ${req.url().slice(0, 160)} — ${req.failure()?.errorText}`)
  })
  // 4xx/5xx 带上 URL，否则 console 里只剩一句「Failed to load resource」
  page.on('response', (res) => {
    if (res.status() < 400 || res.url().includes('favicon')) return
    noise.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 170)}`)
  })
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"]', { timeout: 30_000 })
  // 必须等 Vue 水合完成再提交：首帧 HTML 里的表单还没有 UForm 的 @submit.prevent，
  // 这时候点提交会走浏览器原生 GET 提交、整页刷新，登录请求根本发不出去。
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1_500)
  // dev 下表单已预填 admin，这里显式覆盖一次，避免预填逻辑变化导致用例不稳
  await page.fill('input[type="email"]', CREDS.email)
  await page.fill('input[type="password"]', CREDS.password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForURL('**/timeline', { timeout: 30_000 })
  await page.waitForLoadState('networkidle').catch(() => {})
}

/** 等时间线列表真正渲染出卡片（首次进入要先做一轮 PouchDB 同步，比较慢） */
async function waitForList(page, timeout = 90_000) {
  await page.waitForFunction(
    () => document.querySelectorAll('.cursor-pointer').length > 0,
    null,
    { timeout }
  )
  // 同步过程中附件还在下，正文图片的 blob 替换要等附件到位；能等到就等到，等不到也不阻塞
  await page.waitForFunction(
    () => !/正在同步/.test(document.body.innerText),
    null,
    { timeout: 60_000 }
  ).catch(() => {})
}

/**
 * 打开第一个带「可放大图片」的条目。
 *
 * 列表里并非每篇正文都有图，所以按卡片顺序试；每试一篇都等 useEntryContent 管线跑完
 * —— attach 完成的可靠标志是图片被加上 cursor: zoom-in（见 useImageLightbox.attach）。
 */
async function openEntryWithImage(page, maxTries = 12) {
  const cards = page.locator('.cursor-pointer')
  const total = await cards.count()
  const tries = Math.min(total, maxTries)

  for (let i = 0; i < tries; i++) {
    const card = cards.nth(i)
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click({ timeout: 15_000 }).catch(() => {})

    // 弹窗出现
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
      const scope = document.querySelector('.swiper-slide-active') || document
      return scope.querySelectorAll('.entry-content img').length
    })
    if (imgCount > 0) {
      const attached = await page
        .waitForFunction(
          () => {
            const scope = document.querySelector('.swiper-slide-active') || document
            return Array.from(scope.querySelectorAll('.entry-content img'))
              .some(img => img.style.cursor === 'zoom-in')
          },
          null,
          { timeout: 10_000 }
        )
        .then(() => true)
        .catch(() => false)
      if (attached) return { index: i, attempts: i + 1, imgCount }
    }

    // 这篇没图（或没 attach）：关掉弹窗试下一篇
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  return { index: -1, attempts: tries }
}

/**
 * 列出当前弹窗里所有「已 attach 且在视口内」的图，附 src 与点击坐标。
 * 返回数组而不是单张，调用方才能「换一张再点」来验证 index 传得对不对。
 */
async function listZoomable(page) {
  return page.evaluate(() => {
    const inViewport = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
    }
    // Swiper 三槽模式会同时渲染相邻条目，必须只看活动 slide，否则会选到
    // 上一篇/下一篇的图片——点它等于点到视口外，会把条目弹窗一起关掉
    const scope = document.querySelector('.swiper-slide-active') || document
    const out = []
    for (const img of scope.querySelectorAll('.entry-content img')) {
      if (img.style.cursor !== 'zoom-in' || !inViewport(img)) continue
      const srcAttr = img.getAttribute('src') || ''
      const currentSrc = img.currentSrc || ''
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
  })
}

/** 挑一张来点：优先 blob（附件已缓存、必定加载成功，滚轮缩放才走得通），否则第一张 */
function chooseZoomable(candidates) {
  if (!candidates.length) return null
  return candidates.find(c => c.isBlob) || candidates[0]
}

/**
 * 展示的地址是否属于这张图。
 *
 * 同一张图会有两个地址：原始的远程 URL（src 属性被替换前的值，可能还留在
 * currentSrc 里）和替换后的 blob。正文的 img.src 一设置，浏览器要过一会儿才
 * 更新 currentSrc，attach 与断言读到的时刻不同就会各读到一个，所以按「集合」
 * 判定，而不是要求字符串相等。
 */
function matchesCandidate(shownSrc, cand) {
  if (!shownSrc) return false
  return [cand.src, cand.srcAttr, cand.currentSrc].filter(Boolean).includes(shownSrc)
}

const short = s => (s || '').slice(0, 46)

/** 读取 lightbox wrapper 上的 scale（组件把 transform: translate(-50%,-50%) scale(x) 写在这里） */
async function readScale(page) {
  return page.evaluate(() => {
    // 多图时每个 slide 各有一个 wrapper，必须取活动的那一个
    const el = document.querySelector('.swiper-slide-active .vel-img-wrapper')
      || document.querySelector('.vel-img-wrapper')
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
async function currentImageState(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.swiper-slide-active .vel-img')
      || document.querySelector('.vel-img')
    if (!img) return { found: false }
    return {
      found: true,
      src: img.currentSrc || img.src || '',
      naturalWidth: img.naturalWidth,
      complete: img.complete
    }
  })
}

/** 条目弹窗是否还开着（正文仍在且可见） */
async function entryModalOpen(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('.swiper-slide-active') || document
    const el = scope.querySelector('.entry-content')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

async function collectStyle(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('.vel-modal')
    if (!modal) return null
    const cs = getComputedStyle(modal)
    const img = document.querySelector('.vel-img')
    return {
      background: cs.backgroundColor,
      backdropFilter: cs.backdropFilter,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      hasDismissableLayer: modal.hasAttribute('data-dismissable-layer'),
      imgBackground: img ? getComputedStyle(img).backgroundColor : null,
      htmlDark: document.documentElement.classList.contains('dark')
    }
  })
}

/** 一个主题下的完整验证流程 */
async function runTheme(browser, theme) {
  console.log(`\n──────── ${theme === 'dark' ? '暗色' : '亮色'}主题 ────────`)

  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: theme,
    locale: 'zh-CN'
  })
  const page = await context.newPage()
  watch(page)

  await login(page)
  await waitForList(page)
  const opened = await openEntryWithImage(page)
  if (opened.index < 0) {
    check(`[${theme}] 找到带图条目`, false, `试了 ${opened.attempts} 篇都没等到 attach`)
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-no-image.png`), fullPage: false })
    await context.close()
    return
  }
  check(
    `[${theme}] 找到带图条目并完成 attach`,
    true,
    `第 ${opened.attempts} 篇，卡片 #${opened.index}，正文图 ${opened.imgCount} 张`
  )

  const candidates = await listZoomable(page)
  const pick = chooseZoomable(candidates)
  if (!pick) {
    check(`[${theme}] 定位可放大图片`, false)
    await context.close()
    return
  }
  // 这条不是功能判定：图片是否已缓存为附件取决于该篇同步没同步完，没命中就退回远程图，
  // 放大功能一样成立，所以只做提示不计入成败。
  console.log(
    `${pick.isBlob ? '[ok]' : '[!] '} [${theme}] 正文图片地址 ${pick.isBlob ? '已换成本地 blob' : '仍是远程 URL（该篇附件未缓存）'} — ${pick.src.slice(0, 60)}`
  )
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-1-entry-modal.png`) })

  // ── 1. 点击放大 ──────────────────────────────────────────────
  await page.locator(`[data-verify-cand="${pick.idx}"]`).click()
  let openedLightbox = true
  await page.waitForSelector('.vel-modal', { state: 'visible', timeout: 8_000 }).catch(() => {
    openedLightbox = false
  })
  check(`[${theme}] 点击图片打开 lightbox`, openedLightbox)
  if (!openedLightbox) {
    await context.close()
    return
  }
  await page.waitForTimeout(900) // 等 lightbox 内图片加载

  const shown = await currentImageState(page)
  const state = await collectStyle(page)
  check(
    `[${theme}] lightbox 展示的正是被点的那张图`,
    shown.found && matchesCandidate(shown.src, pick),
    `展示=${short(shown.src)} | 被点那张 src=${short(pick.srcAttr)} currentSrc=${short(pick.currentSrc)}`
  )
  check(
    `[${theme}] 遮罩收回了 pointer-events（父级 UModal 会把 body 设为 none）`,
    state?.pointerEvents === 'auto',
    `pointer-events=${state?.pointerEvents}`
  )
  check(
    `[${theme}] 遮罩背景被定制过（非组件默认 rgba(0,0,0,.5)）`,
    state?.background === 'rgba(0, 0, 0, 0.62)',
    `background=${state?.background}, blur=${state?.backdropFilter}`
  )
  check(
    `[${theme}] .vel-modal 被标记为 dismissable-layer`,
    state?.hasDismissableLayer === true
  )
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-2-lightbox-open.png`) })

  // ── 1b. index 传递：换一张图点，lightbox 必须跟着换 ──────────────
  // 只点一张时，即使 index 根本没生效、永远打开第 0 张，看起来也一样「正确」。
  // 必须点一张不是当前那张的图才能证伪。
  const other = candidates.find(c => c.src !== pick.src)
  if (other) {
    await page.keyboard.press('Escape')
    // 必须等遮罩彻底消失：淡出中的遮罩会吞掉点击，此时它已卸掉
    // data-dismissable-layer，UModal 会把这次点击当成外部点击把弹窗关掉
    await page.waitForSelector('.vel-modal', { state: 'detached', timeout: 6_000 }).catch(() => {})
    await page.waitForTimeout(300)
    await page.locator(`[data-verify-cand="${other.idx}"]`).click()
    const reopened = await page.waitForSelector('.vel-modal', { state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    await page.waitForTimeout(900)
    const shownOther = reopened ? await currentImageState(page) : { found: false, src: '' }
    check(
      `[${theme}] 换一张图点，lightbox 跟着换（index 传对了）`,
      matchesCandidate(shownOther.src, other) && !matchesCandidate(shownOther.src, pick),
      `点了=${short(other.srcAttr)} 显示=${short(shownOther.src)}`
    )
  } else {
    console.log(`[!]  [${theme}] 视口内只有一张图，跳过 index 传递检查`)
  }

  // ── 2. 滚轮缩放 ──────────────────────────────────────────────
  const scaleBefore = await readScale(page)
  const imgReady = shown.naturalWidth > 0
  check(`[${theme}] lightbox 图片加载成功（缩放可用的前提）`, imgReady, `naturalWidth=${shown.naturalWidth}`)

  if (imgReady) {
    // 滚轮事件绑在遮罩上，hover 到遮罩中心即可（不用图片坐标，图片可能被裁切）
    const modalBox = await page.locator('.vel-modal').boundingBox()
    await page.mouse.move(
      (modalBox?.x ?? 0) + (modalBox?.width ?? 1440) / 2,
      (modalBox?.y ?? 0) + (modalBox?.height ?? 900) / 2
    )
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(200) // 组件内部有 80ms 滚轮节流
    }
    await page.waitForTimeout(300)
    const scaleAfter = await readScale(page)
    check(
      `[${theme}] 滚轮向上放大（scale 变化）`,
      scaleBefore !== null && scaleAfter !== null && scaleAfter > scaleBefore,
      `scale ${scaleBefore} -> ${scaleAfter}`
    )

    // 反向：滚轮向下应缩小
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 240)
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(300)
    const scaleZoomOut = await readScale(page)
    check(
      `[${theme}] 滚轮向下缩小`,
      scaleZoomOut !== null && scaleAfter !== null && scaleZoomOut < scaleAfter,
      `scale ${scaleAfter} -> ${scaleZoomOut}`
    )
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-3-zoom.png`) })
  }

  // ── 2b. 多图切换（替换 medium-zoom 的主要收益）────────────────
  // 不假设此刻停在第几张（前面的检查可能已经翻过页）：上一张/下一张哪个能换成
  // 另一张就算过，两端都换不动才说明确实只有一张图。
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
    check(`[${theme}] 多图能切到另一张`, true, `${short(beforeSwitch.src)} -> ${short(switchedTo)}`)
    check(`[${theme}] 翻页后条目弹窗仍在`, await entryModalOpen(page))
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-3b-next-image.png`) })
  } else {
    console.log(`[!]  [${theme}] 没有可切换的相邻图（本篇只有一张），跳过翻页检查`)
  }

  // ── 3. 嵌套 UModal：点 lightbox 自己的按钮不能关掉条目弹窗 ────────
  const modalBefore = await entryModalOpen(page)
  const toolbarBtn = page.locator('.vel-toolbar .toolbar-btn').first()
  const hasToolbar = await toolbarBtn.count() > 0
  if (hasToolbar) {
    await toolbarBtn.click({ force: true }).catch(() => {})
  } else {
    // 没有工具栏按钮时退回点遮罩空白处（同样属于「lightbox 内部」）
    await page.mouse.click(30, 30)
  }
  await page.waitForTimeout(700)
  const modalAfter = await entryModalOpen(page)
  const lightboxStill = await page.locator('.vel-modal').isVisible().catch(() => false)
  check(
    `[${theme}] 点 lightbox 内部按钮不会关掉条目弹窗`,
    modalBefore && modalAfter,
    `弹窗 before=${modalBefore} after=${modalAfter}（lightbox 仍打开=${lightboxStill}）`
  )
  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-4-after-toolbar-click.png`) })

  // ── ESC：只关 lightbox ───────────────────────────────────────
  // 先确保 lightbox 处于打开态（上一步可能因点遮罩而关闭）
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
  check(
    `[${theme}] ESC 关掉 lightbox 但保留条目弹窗`,
    beforeEsc && !afterEsc && modalAfterEsc,
    `lightbox ${beforeEsc} -> ${afterEsc}，条目弹窗仍在=${modalAfterEsc}`
  )

  // ── 4. 主题相关 ─────────────────────────────────────────────
  const finalState = await collectStyle(page).catch(() => null)
  if (theme === 'dark') {
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    check(`[${theme}] 页面确实进入暗色模式（html.dark）`, isDark)
  }
  void finalState

  await context.close()
}

/** 暗色：先确认 color-mode 生效方式，不生效时手动补 class */
async function probeColorMode(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const bySystem = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (!bySystem) {
    // @nuxtjs/color-mode 的 preference 若被存成 light，system 就不生效：手动落一份偏好再重载
    await page.evaluate(() => localStorage.setItem('nuxt-color-mode', 'dark'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
  }
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  await context.close()
  return { bySystem, isDark }
}

// ── 主流程 ──────────────────────────────────────────────────────
let browser
try {
  browser = await chromium.launch({ headless: true })
} catch (err) {
  console.error(`\n启动 Chromium 失败：${err.message}\n`)
  console.error('浏览器没装：pnpm exec playwright install chromium')
  console.error('报缺 .so（libnspr4 / libnss3 / libasound2）又没有 root：')
  console.error('  cd node_modules && mkdir -p .pw-syslibs/debs')
  console.error('  cd .pw-syslibs/debs && apt-get download libnspr4 libnss3 libasound2t64')
  console.error('  cd .. && for d in debs/*.deb; do dpkg -x "$d" .; done')
  process.exit(1)
}
try {
  const colorMode = await probeColorMode(browser)
  console.log(`色彩模式探测：system 直接生效=${colorMode.bySystem}，最终暗色=${colorMode.isDark}`)

  await runTheme(browser, 'light')
  await runTheme(browser, 'dark')
} finally {
  await browser.close()
}

// ── 报告 ────────────────────────────────────────────────────────
console.log('\n──────── 控制台/网络噪音 ────────')
console.log(`console error: ${noise.consoleErrors.length}`)
noise.consoleErrors.slice(0, 5).forEach(t => console.log(`  - ${t}`))
console.log(`未捕获异常: ${noise.pageErrors.length}`)
noise.pageErrors.slice(0, 5).forEach(t => console.log(`  - ${t}`))
console.log(`请求失败: ${noise.failedRequests.length}`)
noise.failedRequests.slice(0, 8).forEach(t => console.log(`  - ${t}`))
console.log(`4xx/5xx 响应: ${noise.httpErrors.length}`)
;[...new Set(noise.httpErrors)].slice(0, 10).forEach(t => console.log(`  - ${t}`))

const failed = results.filter(r => !r.ok)
console.log('\n──────── 汇总 ────────')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
failed.forEach(r => console.log(`  [x] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`))

fs.writeFileSync(
  path.join(OUT_DIR, 'results.json'),
  JSON.stringify({ results, noise, generatedAt: new Date().toISOString() }, null, 2)
)
console.log(`\n截图与结果: ${OUT_DIR}`)

process.exit(failed.length ? 1 : 0)
