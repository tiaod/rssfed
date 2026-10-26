import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright/test'
import { REPO_ROOT } from './support/playwright-env.mjs'
import { expect, test } from './fixtures'
import {
  closeAnyDetail,
  ensureLoggedIn,
  ITEM,
  MODAL,
  PANE,
  SYNC_WAIT_MS,
  waitForList,
  waitForSyncIdle
} from './support/timeline'

/**
 * 真实浏览器验证「正文图片的离线链路」：**先占位、再换本地 blob**，全程不去源站抓图
 * （从 scripts/verify-entry-images.mjs 迁到 Playwright Test）。
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
 * 前置：后端 :3001、前端 :3000 均已在跑；admin 账号可登录（登录态与本地 PouchDB 存在
 * playwright.config.ts 指定的持久化 profile 里，第二次之后很快）。
 * **必须在本地库已经同步到「正文图片缓存成本地附件」的条目之后跑**：用例会在列表前 OPEN_LIMIT
 * 篇里找一篇「正文图全部命中本地附件」的文章作为可判定窗口；找不到就报失败（说明同步/缓存
 * 出了问题，别静默放过 —— 老脚本当时是 soft 通过，等于没验证）。
 *
 * 环境变量：OPEN_LIMIT（默认 10）、SYNC_WAIT_MS。
 */
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'report/entry-images')
const OPEN_LIMIT = Number(process.env.OPEN_LIMIT ?? 10)

/** 有 blurhash 时客户端用的占位图 MIME（纯渐变，JPEG 比 PNG 小两个数量级，见 app/utils/blurhash.ts） */
const BLURHASH_PREFIX = 'data:image/jpeg;base64,'
/** 没有 blurhash 时客户端用的 1×1 透明 PNG（见 app/utils/blurhash.ts） */
const TRANSPARENT_PIXEL
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const PROSE_ANY = `${MODAL} .entry-prose, ${PANE} .entry-prose`

interface ProbeEntry { id: string, src: string, orig: string | null, width: string | null, height: string | null }

interface ImgState {
  src: string
  orig: string | null
  firstSrc: string | null
  firstOrig: string | null
  naturalWidth: number
}

interface RequestRecord {
  url: string
  type: string
  failed?: string
}

interface WindowEntry {
  index: number
  title: string | null
  proseImages: number
  blobImages: number
  remoteImages: number
  placeholderFirst: number
  blurhashPlaceholder: number
  transparentPlaceholder: number
  imageRequests: number
  externalImageRequests: string[]
  imgs: ImgState[]
}

/** 判断某个 URL 是不是「本站」（前端 :3000 / 后端 :3001）；其它一律算源站 */
function isLocal(url: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(3000|3001)(\/|$)/.test(url)
    || url.startsWith('blob:')
    || url.startsWith('data:')
}

/** 给 context 挂监听（不是给某个 page）：登录/跳转可能换页，挂在 context 上不会漏 */
function watchRequests(context: BrowserContext, requests: RequestRecord[]) {
  context.on('request', r => requests.push({ url: r.url(), type: r.resourceType() }))
  context.on('requestfailed', (r) => {
    for (let i = requests.length - 1; i >= 0; i -= 1) {
      if (requests[i].url === r.url() && !requests[i].failed) {
        requests[i].failed = r.failure()?.errorText
        break
      }
    }
  })
}

/**
 * 装探针：记录每张正文图**第一次出现在 DOM 里**的 src（占位还是原地址），并打上 id 便于事后对齐。
 * MutationObserver 的回调在微任务里跑，`v-html` 整块插入已经完成 —— 此时看到的 src 就是
 * 「浏览器开始抓图时用的那个 src」。
 */
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __imgProbe: { first: ProbeEntry[], seq: number } }
    w.__imgProbe = { first: [], seq: 0 }
    const seen = new WeakSet()
    const record = (img: HTMLImageElement) => {
      if (!img || img.tagName !== 'IMG' || seen.has(img)) return
      if (!img.closest('.entry-prose')) return
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
        if (m.type === 'attributes') record(m.target as HTMLImageElement)
        else {
          if (m.target.nodeType === 1) record(m.target as HTMLImageElement)
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue
            if ((n as HTMLElement).tagName === 'IMG') record(n as HTMLImageElement)
            ;(n as HTMLElement).querySelectorAll?.('img').forEach(img => record(img as HTMLImageElement))
          }
        }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  })
}

/** 读当前正文里的图 + 探针里它们的「首见 src」 */
async function readProseImages(page: Page) {
  return page.evaluate((sel) => {
    const prose = document.querySelector(sel)
    if (!prose) return null
    const w = window as unknown as { __imgProbe?: { first: ProbeEntry[] } }
    const probe = w.__imgProbe?.first ?? []
    const imgs = Array.from(prose.querySelectorAll('img'))
    return {
      title: (document.querySelector('.entry-detail-modal-content h1, [aria-label="文章阅读"] h1')?.textContent ?? '').slice(0, 60),
      imgs: imgs.map((img) => {
        const id = img.getAttribute('data-probe-id')
        const first = probe.find((p: ProbeEntry) => p.id === id) ?? null
        return {
          src: img.getAttribute('src') ?? '',
          orig: img.getAttribute('data-orig-src'),
          firstSrc: first?.src ?? null,
          firstOrig: first?.orig ?? null,
          naturalWidth: (img as HTMLImageElement).naturalWidth
        }
      })
    }
  }, PROSE_ANY) as Promise<{ title: string, imgs: ImgState[] } | null>
}

test.describe('正文图片的离线链路', () => {
  test('占位先于注入、零源站请求、图上屏', async ({ appPage, e2eContext, jsErrors }) => {
    test.setTimeout(SYNC_WAIT_MS + 240_000)
    jsErrors.length = 0
    fs.mkdirSync(OUT, { recursive: true })

    const requests: RequestRecord[] = []
    watchRequests(e2eContext, requests)

    await ensureLoggedIn(appPage)
    await appPage.goto('/timeline', { waitUntil: 'domcontentloaded' })
    expect(await waitForList(appPage, SYNC_WAIT_MS), '本地库有条目（已完成首屏同步）').toBe(true)
    // 冷 profile 上「列表出现」不等于附件都落盘了：等同步彻底空闲再开始找窗口，
    // 否则会误判「正文图没有缓存成本地附件」（断言依赖的是附件而非条目）
    await waitForSyncIdle(appPage, 120_000)
    await appPage.waitForTimeout(1_500)
    await installProbe(appPage)

    const items = appPage.locator(ITEM).filter({ has: appPage.locator('[data-entry-id]') })
    const total = Math.min(await items.count(), OPEN_LIMIT)
    console.log(`[i] 列表前 ${total} 篇里找「正文图全部命中本地附件」的可判定窗口`)
    const windows: WindowEntry[] = []
    let judged: WindowEntry | null = null

    for (let i = 0; i < total; i += 1) {
      const from = requests.length
      await items.nth(i).click()
      await appPage.locator(PROSE_ANY).first().waitFor({ timeout: 20_000 }).catch(() => {})
      // 等附件读完 + blob 换好：这一步之后不该再有新的图片请求
      await appPage.waitForTimeout(3_000)

      const detail = await readProseImages(appPage)
      const windowRequests = requests.slice(from)
      const mine = detail?.imgs ?? []
      const imageRequests = windowRequests.filter(r => r.type === 'image')
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
        imgs: mine
      }
      windows.push(entry)
      console.log(`[i] #${i} ${entry.title ?? '(无标题)'}：正文图 ${entry.proseImages}（blob ${entry.blobImages} / 远端 ${entry.remoteImages}）占位首见 ${entry.placeholderFirst}，图片请求 ${entry.imageRequests}（源站 ${externalImageRequests.length}）`)
      await appPage.screenshot({ path: path.join(OUT, `window-${i}.png`) })

      const allLocal = mine.length > 0 && mine.every(m => m.src.startsWith('blob:'))
      await closeAnyDetail(appPage)
      await appPage.waitForTimeout(800)

      if (allLocal) {
        judged = entry
        break
      }
    }

    // 找不到可判定窗口说明「正文图缓存成本地附件」这条前提没成立：报失败，别静默通过
    expect.soft(!!judged, `前 ${total} 篇里找到「正文图全部命中本地附件」的文章（探测结果见 result.json）`).toBe(true)

    if (judged) {
      const mine: ImgState[] = judged.imgs
      const sourceUrls = mine.map(m => m.firstOrig).filter(Boolean) as string[]
      const leaked = (judged.externalImageRequests as string[]).filter(u => sourceUrls.some(s => u.startsWith(s)))

      // A. 占位先于注入：首见 src 是 data: 占位（不是源站地址）
      expect.soft(
        mine.every(m => m.firstSrc?.startsWith('data:')),
        `占位先于注入：每张本地图首见 src 都是 data: 占位（不是源站地址）—— ${mine.map(m => `${m.firstSrc?.slice(0, 34)}…`).join(' | ')}`
      ).toBe(true)
      // B. 零源站请求（本用例正题）
      expect.soft(
        leaked.length === 0,
        `零源站请求：这篇文章的图片原始地址一次都没被请求（含被取消的）—— ${leaked.length ? leaked.join(' | ') : `${sourceUrls.length} 张图，源站请求 0 次`}`
      ).toBe(true)
      // C. 图上屏
      expect.soft(
        mine.every(m => m.src.startsWith('blob:') && m.naturalWidth > 0),
        `图上屏：窗口结束后正文图全部是本地 blob 且已解码 —— ${mine.map(m => `${m.src.slice(0, 18)}…/${m.naturalWidth}px`).join(' | ')}`
      ).toBe(true)
      // D. blurhash 占位（老条目没有 blurhash 时只提示）
      expect.soft(
        judged.blurhashPlaceholder > 0,
        judged.blurhashPlaceholder > 0
          ? `占位图用的是 blurhash 解出的图（${judged.blurhashPlaceholder}/${mine.length} 张，另有 ${judged.transparentPlaceholder} 张走透明兜底）`
          : '本次命中的条目都还没有 blurhash 字段（老数据，等条目重新抓取后会带上）'
      ).toBe(true)
    }

    // 证据落盘（report/ 是 gitignore，只在本机）
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({
      results: { judged: judged?.title ?? null, windows },
      externalImageRequests: requests.filter(r => r.type === 'image' && !isLocal(r.url))
    }, null, 2))
    console.log(`[i] 证据写入 ${path.join(OUT, 'result.json')}`)

    // E. 无新增 JS 运行时错误
    expect.soft(jsErrors.slice(0, 3), jsErrors.slice(0, 3).join(' | ')).toEqual([])
  })
})
