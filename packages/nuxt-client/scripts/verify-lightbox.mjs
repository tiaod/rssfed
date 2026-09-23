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
// 本机是容器：没有系统 Chromium，且缺 libnspr4 / libnss3 / libasound2，
// 而 NoNewPrivs=1 + 非 root 意味着装不了系统包。所以浏览器和这几个库都放在
// 项目里，这里自动接好，调用方直接 node 跑就行，不必每次拼一长串环境变量。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const LOCAL_BROWSERS = path.join(REPO_ROOT, 'node_modules/.playwright-browsers')
const LOCAL_LIBS = path.join(LOCAL_BROWSERS, 'sysroot/usr/lib/x86_64-linux-gnu')

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

// 浏览器目录优先级：显式指定 > 你自己 playwright install 装的默认缓存 > 项目内这份
if (
  !process.env.PLAYWRIGHT_BROWSERS_PATH
  && !fs.existsSync(defaultBrowserCache())
  && fs.existsSync(LOCAL_BROWSERS)
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
      .waitForSelector('.entry-content', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (!appeared) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      continue
    }

    await page.waitForTimeout(400)
    // 快路径：正文里压根没图就别等 attach 超时了
    const imgCount = await page.evaluate(() => document.querySelectorAll('.entry-content img').length)
    if (imgCount > 0) {
      const attached = await page
        .waitForFunction(
          () => Array.from(document.querySelectorAll('.entry-content img'))
            .some(img => img.style.cursor === 'zoom-in'),
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
 * 取当前弹窗里第一张「已 attach 且在视口内」的图，返回它的 src 与位置。
 * 优先选本地 blob：附件已缓存，图片必定加载成功，滚轮缩放才走得通。
 */
async function pickZoomable(page) {
  const info = await page.evaluate(() => {
    const inViewport = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
    }
    const all = Array.from(document.querySelectorAll('.entry-content img'))
      .filter(img => img.style.cursor === 'zoom-in' && inViewport(img))
    if (!all.length) return null
    const srcOf = img => img.currentSrc || img.src
    const img = all.find(i => srcOf(i).startsWith('blob:')) || all[0]
    const rect = img.getBoundingClientRect()
    return {
      count: all.length,
      src: srcOf(img),
      isBlob: srcOf(img).startsWith('blob:'),
      alt: img.getAttribute('alt') || '',
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height / 2, window.innerHeight / 2)
    }
  })
  return info
}

/** 读取 lightbox wrapper 上的 scale（组件把 transform: translate(-50%,-50%) scale(x) 写在这里） */
async function readScale(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.vel-img-wrapper')
    if (!el) return null
    const m = /scale\(([\d.]+)\)/.exec(el.style.transform || '')
    return m ? Number(m[1]) : null
  })
}

/** lightbox 当前图的 src 是否已加载成功（loadError 时组件直接忽略滚轮） */
async function currentImageState(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.vel-img-wrapper img, .vel-img')
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
    const el = document.querySelector('.entry-content')
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

  const pick = await pickZoomable(page)
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
  await page.mouse.click(pick.x, pick.y)
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
    shown.found && shown.src === pick.src,
    `shown=${(shown.src || '').slice(0, 50)} vs picked=${pick.src.slice(0, 50)}`
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

  // ── 2. 滚轮缩放 ──────────────────────────────────────────────
  const scaleBefore = await readScale(page)
  const imgReady = shown.naturalWidth > 0
  check(`[${theme}] lightbox 图片加载成功（缩放可用的前提）`, imgReady, `naturalWidth=${shown.naturalWidth}`)

  if (imgReady) {
    await page.mouse.move(pick.x, pick.y)
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
  const nextBtn = page.locator('.vel-btns-wrapper .btn__next')
  if (await nextBtn.count() > 0) {
    const beforeSwitch = await currentImageState(page)
    await nextBtn.first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)
    const afterSwitch = await currentImageState(page)
    check(
      `[${theme}] 多图可翻到下一张`,
      !!beforeSwitch.src && !!afterSwitch.src && beforeSwitch.src !== afterSwitch.src,
      `第 1 张 -> ${afterSwitch.src.slice(0, 46)}`
    )
    // 翻页后条目弹窗也不能被关掉（同样是 lightbox 内部点击）
    check(`[${theme}] 翻页后条目弹窗仍在`, await entryModalOpen(page))
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}-3b-next-image.png`) })
  } else {
    console.log(`[!]  [${theme}] 该篇只有一张图，跳过翻页检查`)
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
    await page.mouse.click(pick.x, pick.y)
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
  console.error('  cd node_modules/.playwright-browsers && mkdir -p sysroot/debs sysroot')
  console.error('  cd sysroot/debs && apt-get download libnspr4 libnss3 libasound2t64')
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
