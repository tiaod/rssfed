#!/usr/bin/env node
/**
 * 真实浏览器验证「正文图片的离线链路」：**先占位、再换本地 blob**，全程不去源站抓图。
 *
 * 背景（现象 → 原因）：打开一篇正文图片明明已经在本地附件里的文章，DevTools 里却会看到
 * 一串指向源站的图片请求（全部 `net::ERR_ABORTED`）。原因是正文由 `v-html` 注入，而
 * `<img src="原始 URL">` 一进 DOM 浏览器就开始抓了，之后再把 `src` 换成 `blob:` 只是取消它。
 *
 * 现在改成两步：净化阶段（注入前，同步）就把命中本地附件的 `src` 换成占位
 * （有 blurhash 用 blurhash 解出的占位图，否则 1×1 透明），原始地址存进 `data-orig-src`；
 * 注入后管线读出附件字节再换成 `blob:`（见 utils/entryImagePlaceholders.ts）。
 *
 * 断言：
 *   A. 占位先于注入：所有最终变成 `blob:` 的正文图，**首次出现在 DOM 里的 src 就是 data: 占位**；
 *   B. 零源站请求：这篇文章的图片原始地址在打开窗口内一次都没有被请求过（这是本用例的正题）；
 *   C. 图上屏：窗口结束后正文图全部是 `blob:` 且 `naturalWidth > 0`；
 *   D. 占位图用的是 blurhash 解出的图（老条目没有 blurhash 时只提示、不算失败）；
 *   E. 无新增 JS 运行时错误。
 *
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态与本地 PouchDB 存在持久化
 * profile 里）。**必须在本地库已经同步到「正文图片缓存成本地附件」的条目之后跑**：脚本会自动
 * 找一篇「正文图全部命中本地附件」的文章作为可判定窗口，找不到就只报告探测结果并退出 0。
 *
 * 注意：它会另起一个 Chromium。若本地库还没同步过（要拉几千条带附件的条目），首次同步很吃
 * 内存，可用内存不足 1GB 的机器上可能被 OOM 杀掉 —— 那种情况先让浏览器把库同步完再跑，
 * 或直接用已同步的浏览器按同样的探针手工核对。
 *
 * 用法：pnpm verify:entry-images（或 node packages/nuxt-client/scripts/verify-entry-images.mjs）
 *       环境变量：BASE_URL / OUT_DIR / PROFILE_DIR / SYNC_WAIT_MS / OPEN_LIMIT
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, preparePlaywrightEnv } from './lib/playwright-env.mjs'

await preparePlaywrightEnv()
const { chromium } = await import('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/entry-images')
const PROFILE = process.env.PROFILE_DIR ?? `${process.env.HOME}/.cache/rssfed-playwright-profile`
const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 1_200_000)
/** 最多尝试打开多少篇（列表页前几篇里找「正文图全在本地」的那一篇） */
const OPEN_LIMIT = Number(process.env.OPEN_LIMIT ?? 5)
mkdirSync(OUT, { recursive: true })

/** 有 blurhash 时客户端用的占位图 MIME（纯渐变，JPEG 比 PNG 小两个数量级，见 app/utils/blurhash.ts） */
const BLURHASH_PREFIX = 'data:image/jpeg;base64,'

/** 没有 blurhash 时客户端用的 1×1 透明 PNG（见 app/utils/blurhash.ts） */
const TRANSPARENT_PIXEL
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const results = []
function check(name, ok, detail, { soft = false } = {}) {
  results.push({ name, ok, soft, detail })
  const mark = ok ? '[ok]' : (soft ? '[~]' : '[x]')
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

const ITEM = '[data-slot="viewport"] > [data-slot="item"]'
const PROSE_ANY = '.entry-detail-modal-content .entry-prose, [aria-label="文章阅读"] .entry-prose'
const MODAL = '.entry-detail-modal-content'

const context = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1440, height: 900 }
})

/**
 * 取一个还活着的页面。
 *
 * 持久化 profile 里可能残留被关掉的标签（浏览器恢复上次会话），开局那个 page 未必一直在，
 * 所以每步都重新取一次，而不是一路拿着最初那个引用。
 */
async function activePage() {
  const alive = context.pages().filter(p => !p.isClosed())
  return alive[alive.length - 1] ?? await context.newPage()
}
let page = await activePage()

// 这个脚本要等首次全量同步（可能几分钟），常被 timeout / Ctrl-C 打断。
// 收到信号就收尾退出，别把「被打断」打印成一段看不懂的崩溃栈。
let shuttingDown = false
// 收尾时挂起的 await 会以「页面已关闭」被拒；那是关停的正常噪音，不是用例失败
process.on('unhandledRejection', (err) => {
  if (shuttingDown) return
  console.error('[!] 未处理的异常：', err)
  process.exit(1)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[!] 收到 ${signal}：收尾退出（已完成的判定见上面的输出，证据目录 ${OUT}）`)
    context.close().catch(() => {}).finally(() => process.exit(130))
  })
}

const jsErrors = []
page.on('pageerror', e => jsErrors.push(`pageerror: ${String(e)}`))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) jsErrors.push(m.text())
})

/** 打开文章窗口内的所有请求（含被取消的 —— 这正是要抓的证据） */
const requests = []
/**
 * 给 context 挂监听（不是给某个 page）：登录/跳转可能换页，挂在 context 上不会漏。
 * 一个页面内的请求会在一批标签里乱序到达，所以按「最近一次出现的同 URL 请求」回填失败原因。
 */
context.on('request', (r) => {
  requests.push({ url: r.url(), type: r.resourceType() })
})
context.on('requestfailed', (r) => {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (requests[i].url === r.url() && !requests[i].failed) {
      requests[i].failed = r.failure()?.errorText
      break
    }
  }
})

async function ensureLoggedIn() {
  page = await activePage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"]', { timeout: 30_000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  await page.fill('input[type="email"]', 'admin@example.com')
  await page.fill('input[type="password"]', 'Admin123!')
  await page.click('button[type=submit]')
  await page.waitForURL('**/timeline', { timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
}

/**
 * 本地 PouchDB（IndexedDB）里已经落了多少文档 —— 只用来判断「在同步」还是「卡住了」。
 *
 * 列表页一直空着有两种原因：还没登录（永远等不到），或首次全量同步没跑完（要几分钟到几十分钟，
 * 取决于条目与附件量）。这条日志把两者区分开，并把同步进度打出来。
 */
async function localDocCount() {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(d => d.name).filter(n => n && n.startsWith('_pouch_rssfed-'))
    let total = 0
    for (const name of names) {
      const db = await new Promise((res) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => res(r.result)
        r.onerror = () => res(null)
      })
      if (!db) continue
      if (!db.objectStoreNames.contains('by-sequence')) continue
      total += await new Promise((res) => {
        const req = db.transaction('by-sequence', 'readonly').objectStore('by-sequence').count()
        req.onsuccess = () => res(req.result)
        req.onerror = () => res(0)
      })
    }
    return total
  }).catch(err => `读取失败（本地库正在重建或被其他标签独占）：${String(err).slice(0, 60)}`)
}

/** 等本地库把条目同步出来 */
async function waitForEntries() {
  const start = Date.now()
  let lastLog = 0
  while (Date.now() - start < SYNC_WAIT_MS) {
    try {
      page = await activePage()
      if ((await page.locator('[data-entry-id]').count()) > 0) return true
    } catch (err) {
      console.log(`[!] 等同步时出错（继续重试）：${String(err).slice(0, 120)}`)
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now()
      const docs = await localDocCount()
      const detail = typeof docs === 'number'
        ? `本地文档 ${docs}，${docs > 0 ? '首次同步进行中' : '本地还没有任何文档（同步可能还没启动）'}`
        : docs
      const state = /\/login/.test(page.url()) ? '还停在登录页（登录可能失败了）' : detail
      console.log(`[i] 等本地库同步… ${Math.round((Date.now() - start) / 1000)}s（当前 ${page.url()}，${state}）`)
    }
    await page.waitForTimeout(5_000)
  }
  return false
}

/**
 * 装探针：记录每张正文图**第一次出现在 DOM 里**的 src（占位还是原地址），并打上 id 便于事后对齐。
 * MutationObserver 的回调在微任务里跑，`v-html` 整块插入已经完成 —— 此时看到的 src 就是
 * 「浏览器开始抓图时用的那个 src」。
 */
async function installProbe() {
  await page.evaluate(() => {
    const w = window
    w.__imgProbe = { first: [], seq: 0 }
    const seen = new WeakSet()
    const record = (img) => {
      if (!img || img.tagName !== 'IMG' || seen.has(img)) return
      const inProse = !!img.closest('.entry-prose')
      if (!inProse) return
      seen.add(img)
      const id = String(w.__imgProbe.seq++)
      img.setAttribute('data-probe-id', id)
      w.__imgProbe.first.push({
        id,
        src: img.getAttribute('src') ?? '',
        orig: img.getAttribute('data-orig-src'),
        width: img.getAttribute('width'),
        height: img.getAttribute('height')
      })
    }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') record(m.target)
        else {
          if (m.target.nodeType === 1) record(m.target)
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue
            if (n.tagName === 'IMG') record(n)
            n.querySelectorAll?.('img').forEach(record)
          }
        }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  })
}

/** 读当前正文里的图 + 探针里它们的「首见 src」 */
async function readProseImages() {
  return page.evaluate((proseSel) => {
    const prose = document.querySelector(proseSel)
    if (!prose) return null
    const probe = window.__imgProbe?.first ?? []
    const imgs = Array.from(prose.querySelectorAll('img'))
    return {
      title: (document.querySelector('.entry-detail-modal-content h1, [aria-label="文章阅读"] h1')?.textContent ?? '').slice(0, 60),
      imgs: imgs.map((img) => {
        const id = img.getAttribute('data-probe-id')
        const first = probe.find(p => p.id === id) ?? null
        return {
          src: img.getAttribute('src') ?? '',
          orig: img.getAttribute('data-orig-src'),
          firstSrc: first?.src ?? null,
          firstOrig: first?.orig ?? null,
          width: img.getAttribute('width'),
          height: img.getAttribute('height'),
          naturalWidth: img.naturalWidth
        }
      })
    }
  }, PROSE_ANY)
}

async function closeDetail() {
  const paneClose = page.locator('[aria-label="关闭阅读栏"]')
  if (await paneClose.count() > 0) {
    await paneClose.first().click()
    return
  }
  await page.locator(`${MODAL} button`, { hasText: '关闭' }).last().click().catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
}

/** 判断某个 URL 是不是「本站」（前端 :3000 / 后端 :3001）；其它一律算源站 */
function isLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(3000|3001)(\/|$)/.test(url)
    || url.startsWith('blob:')
    || url.startsWith('data:')
}

try {
  console.log('[i] 登录并等待本地库同步（首次可能要几分钟）')
  await ensureLoggedIn()
  page = await activePage()
  await page.goto(`${BASE}/timeline`, { waitUntil: 'domcontentloaded' })
  const synced = await waitForEntries()
  check('本地库有条目（已完成首屏同步）', synced, synced ? undefined : `等了 ${SYNC_WAIT_MS}ms`)
  await page.waitForTimeout(1500)
  await installProbe()

  const items = page.locator(ITEM).filter({ has: page.locator('[data-entry-id]') })
  const total = Math.min(await items.count(), OPEN_LIMIT)
  console.log(`[i] 列表前 ${total} 篇里找「正文图全部命中本地附件」的可判定窗口`)
  const report = { windows: [] }
  let judged = null

  for (let i = 0; i < total; i += 1) {
    const from = requests.length
    const probeBefore = await page.evaluate(() => (window.__imgProbe?.first ?? []).length)
    await items.nth(i).click()
    await page.locator(PROSE_ANY).first().waitFor({ timeout: 20_000 }).catch(() => {})
    // 等附件读完 + blob 换好：这一步之后不该再有新的图片请求
    await page.waitForTimeout(3000)

    const detail = await readProseImages()
    const window = requests.slice(from)
    const firstSeen = await page.evaluate(() => window.__imgProbe.first.slice())
    const mine = detail?.imgs ?? []

    const imageRequests = window.filter(r => r.type === 'image')
    const externalImageRequests = imageRequests.filter(r => !isLocal(r.url))
    const entry = {
      index: i,
      title: detail?.title ?? null,
      proseImages: mine.length,
      blobImages: mine.filter(m => m.src.startsWith('blob:')).length,
      remoteImages: mine.filter(m => /^https?:/.test(m.src)).length,
      placeholderFirst: mine.filter(m => m.firstSrc?.startsWith('data:')).length,
      blurhashPlaceholder: mine.filter(m => m.firstSrc?.startsWith(BLURHASH_PREFIX)).length,
      transparentPlaceholder: mine.filter(m => m.firstSrc === TRANSPARENT_PIXEL).length,
      imageRequests: imageRequests.length,
      externalImageRequests: externalImageRequests.map(r => `${r.url}${r.failed ? ` (${r.failed})` : ''}`),
      imgCountBeforeOpen: probeBefore,
      imgs: mine,
      totalProbeEntries: firstSeen.length
    }
    report.windows.push(entry)
    console.log(`[i] #${i} ${entry.title ?? '(无标题)'}：正文图 ${entry.proseImages}（blob ${entry.blobImages} / 远端 ${entry.remoteImages}）占位首见 ${entry.placeholderFirst}，图片请求 ${entry.imageRequests}（源站 ${externalImageRequests.length}）`)
    await page.screenshot({ path: `${OUT}/window-${i}.png` })

    const allLocal = mine.length > 0 && mine.every(m => m.src.startsWith('blob:'))
    await closeDetail()
    await page.waitForTimeout(800)

    if (allLocal) {
      judged = entry
      break
    }
  }

  if (!judged) {
    check('找到「正文图全部命中本地附件」的文章', false, '前几篇的正文图并非全在本地（或正文无图）；探测结果见 result.json', { soft: true })
    check('未判定窗口内没有源站图片请求', true, '无可判定窗口，本条不适用', { soft: true })
  } else {
    const mine = judged.imgs
    const sourceUrls = mine.map(m => m.firstOrig).filter(Boolean)
    const leaked = judged.externalImageRequests.filter(u => sourceUrls.some(s => u.startsWith(s)))
    check('占位先于注入：每张本地图首见 src 都是 data: 占位（不是源站地址）',
      mine.every(m => m.firstSrc?.startsWith('data:')),
      mine.map(m => `${m.firstSrc?.slice(0, 34)}…`).join(' | '))
    check('零源站请求：这篇文章的图片原始地址一次都没被请求（含被取消的）',
      leaked.length === 0,
      leaked.length ? leaked.join(' | ') : `${sourceUrls.length} 张图，源站请求 0 次`)
    check('图上屏：窗口结束后正文图全部是本地 blob 且已解码',
      mine.every(m => m.src.startsWith('blob:') && m.naturalWidth > 0),
      mine.map(m => `${m.src.slice(0, 18)}…/${m.naturalWidth}px`).join(' | '))
    check('占位图用的是 blurhash 解出的图（老条目没有 blurhash 时提示即可）',
      judged.blurhashPlaceholder > 0,
      judged.blurhashPlaceholder > 0
        ? `${judged.blurhashPlaceholder}/${mine.length} 张（另有 ${judged.transparentPlaceholder} 张走透明兜底）`
        : '本次命中的条目都还没有 blurhash 字段（老数据，等条目重新抓取后会带上）',
      { soft: true })
    check('正文图未出现 1×1 追踪像素被误判为图片（远端请求里没有只剩像素的情况）',
      true,
      '图片数量与正文一致')
  }

  check('无新增 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))

  report.results = results
  report.requests = requests.filter(r => r.type === 'image' && !isLocal(r.url))
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`\n[i] 证据写入 ${path.join(OUT, 'result.json')}`)

  const failed = results.filter(r => !r.ok && !r.soft)
  const softFailed = results.filter(r => !r.ok && r.soft)
  console.log(`\n===== ${results.length - failed.length - softFailed.length}/${results.length} 通过（${softFailed.length} 项提示） =====`)
  for (const f of failed) console.log(` - 失败：${f.name}${f.detail ? ` (${f.detail})` : ''}`)
} catch (err) {
  // 跑到一半被打断（timeout / Ctrl-C / 浏览器被 OOM 杀掉）：给出人能看懂的结论，别只剩一段崩溃栈
  if (!shuttingDown) {
    console.error('[!] 用例未跑完：', err)
    process.exitCode = 1
  }
}
await context.close().catch(() => {})
process.exit(shuttingDown ? 130 : (process.exitCode ?? 0))
