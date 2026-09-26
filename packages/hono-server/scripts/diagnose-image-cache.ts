import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import { extractImageUrls } from "../src/rss/entry-images"

/**
 * 正文图片缓存诊断（只读）。
 *
 * 目的：在不下载任何图片、不改任何数据的前提下，量化回答「为什么很多条目没有图片缓存」。
 *
 * 判定口径：
 *   - 「正文图数」用后端同一函数 extractImageUrls 复算，保证与抓取时一致；
 *   - 「策略上限」来自 PostgreSQL feeds 表的 per-feed 配置（cacheImages / maxImageCount），
 *     未覆盖时回退全局默认；开了 cacheImages 且未设 maxImageCount 视为不限量；
 *   - 因此可以把「策略性截断」（正文 20 张、按策略只存 5 张）与「本该缓存却失败」
 *     严格区分开 —— 后者才是要修的问题。
 *
 * 注意：现行策略已是「每篇附件总体积预算 + 张数硬顶 200」（见 entry-images.ts），
 * 本脚本按「张数上限」做的对照是**历史口径**；评估预算策略请加 `--simulate`，
 * 它用实测附件体积序列模拟不同预算下的覆盖率与存储量。
 *
 * 用法：
 *   pnpm --filter @rssfed/hono-server exec tsx scripts/diagnose-image-cache.ts
 *   pnpm --filter @rssfed/hono-server exec tsx scripts/diagnose-image-cache.ts --sample=20
 */

const COUCH_URL = (process.env.COUCHDB_URL ?? "http://localhost:5984").replace(/\/+$/, "")
const COUCH_USER = process.env.COUCHDB_USER ?? ""
const COUCH_PASS = process.env.COUCHDB_PASSWORD ?? ""
const AUTH = "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASS}`).toString("base64")

const FEED_PREFIX = "feed_"
/** 每页拉取的文档数：单库最大约 2 万文档，分页避免整库进内存 */
const PAGE = 250
/** 并发扫描的库数 */
const CONCURRENCY = 6
/** 图片缓存功能上线日期（commit 7b1adaf），用于区分历史遗留与新增失败 */
const CACHE_CUTOVER = "2026-08-12"
/** 全局默认每篇张数硬顶，与 entry-images.ts 的 DEFAULT_MAX_IMAGE_COUNT 保持一致 */
const DEFAULT_MAX_IMAGE_COUNT = 200
/** 抽样展示的完全未命中条目数 */
const SAMPLE_N = Number(process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1] ?? 10)
/** 抽样探测原图 URL 的条目数（0 = 关闭；开启后会向源站发轻量 HEAD 请求） */
const PROBE_N = Number(process.argv.find((a) => a.startsWith("--probe="))?.split("=")[1] ?? 0)
/** 是否模拟「每篇附件体积预算」策略（复用本次扫描的实测附件体积序列） */
const SIMULATE = process.argv.includes("--simulate")
/** 探测并发 */
const PROBE_CONCURRENCY = 8
/** 与 entry-images.ts 的 DEFAULT_MAX_SOURCE_IMAGE_BYTES 保持一致 */
const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_IMAGE_BYTES ?? 8388608)

// ── 统计容器 ──

interface FeedConfig {
  feedId: string
  cacheImages: boolean | null
  maxImageCount: number | null
  maxImageWidth: number | null
  avifQuality: number | null
  maxSourceImageBytes: number | null
}

interface YearMonthBucket {
  entries: number
  noImg: number
  full: number
  partial: number
  none: number
}

interface Stats {
  dbs: number
  dbErrors: number
  docs: number
  entryDocs: number
  skippedDocs: number
  /** 正文无图（不适用） */
  noImg: number
  /** 正文无图但有协议封面附件 */
  coverOnly: number
  /** 策略内应缓存的图全部命中 */
  full: number
  /** 正文有图，命中了一部分（有失败） */
  partial: number
  /** 正文有图，一张都没缓存（全部失败） */
  none: number
  /** images 字段引用了不存在的附件 */
  brokenRefs: number
  /** 有附件但无 images 字段（旧格式/异常） */
  attsWithoutImages: number
  /** 正文图数分布桶：key → { entries, expectedSum, cachedSum, truncated } */
  buckets: Map<string, { entries: number, expected: number, cached: number, truncated: number }>
  /** insertedAt 年月 → 分类计数 */
  byMonth: Map<string, YearMonthBucket>
  /** 上线前后对比 */
  beforeCutover: YearMonthBucket
  afterCutover: YearMonthBucket
  /** 附件体积（压缩后真实字节，CouchDB _attachments.length） */
  attBytes: number[]
  attCount: number
  /** 单条目附件总字节 */
  entryAttBytes: number[]
  /** 未命中/部分命中样例（供展示与失败原因探测） */
  samples: Array<{ id: string, url: string, expected: number, cached: number, limit: number, insertedAt: string, db: string, kind: "none" | "partial", urls: string[] }>
  /** 截断统计：正文图数超过策略上限的条目数 */
  truncatedEntries: number
  /** 截断条目里，实际缓存数正好等于上限的（正常截断） */
  truncatedAtLimit: number
  /** --simulate：正文有图条目的「原文图数 + 已缓存附件体积序列」，用于预算策略模拟 */
  profiles: Array<{ expected: number, sizes: number[] }>
}

const stats: Stats = {
  dbs: 0, dbErrors: 0, docs: 0, entryDocs: 0, skippedDocs: 0,
  noImg: 0, coverOnly: 0, full: 0, partial: 0, none: 0,
  brokenRefs: 0, attsWithoutImages: 0,
  buckets: new Map(), byMonth: new Map(),
  beforeCutover: emptyBucket(), afterCutover: emptyBucket(),
  attBytes: [], attCount: 0, entryAttBytes: [],
  samples: [], truncatedEntries: 0, truncatedAtLimit: 0, profiles: [],
}

function emptyBucket(): YearMonthBucket {
  return { entries: 0, noImg: 0, full: 0, partial: 0, none: 0 }
}

function bucketKey(expected: number): string {
  if (expected <= 5) return String(expected)
  if (expected <= 10) return "6-10"
  if (expected <= 20) return "11-20"
  return ">20"
}

// ── CouchDB 只读访问 ──

async function listFeedDbs(): Promise<string[]> {
  const res = await fetch(`${COUCH_URL}/_all_dbs`, { headers: { Authorization: AUTH } })
  if (!res.ok) throw new Error(`_all_dbs 失败：HTTP ${res.status}`)
  const all = (await res.json()) as string[]
  return all.filter((n) => n.startsWith(FEED_PREFIX))
}

/** 分页遍历一个库的全部文档；只取 include_docs（附件仅为 stub，不下载二进制） */
async function scanDb(dbName: string, onDoc: (doc: Record<string, unknown>) => void): Promise<void> {
  let startkey: string | undefined
  for (;;) {
    const qs = new URLSearchParams({ include_docs: "true", limit: String(PAGE) })
    if (startkey) {
      qs.set("startkey", JSON.stringify(startkey))
      qs.set("skip", "1")
    }
    const res = await fetch(`${COUCH_URL}/${dbName}/_all_docs?${qs}`, { headers: { Authorization: AUTH } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { rows?: Array<{ id: string, doc?: Record<string, unknown> }> }
    const rows = json.rows ?? []
    if (rows.length === 0) return
    for (const row of rows) {
      if (row.doc) onDoc(row.doc)
    }
    startkey = rows[rows.length - 1]!.id
    if (rows.length < PAGE) return
  }
}

// ── per-feed 策略（PostgreSQL 为权威来源） ──

async function loadFeedConfigs(): Promise<Map<string, FeedConfig>> {
  const map = new Map<string, FeedConfig>()
  try {
    const { db, feeds } = await import("../src/db")
    const rows = await db.select({
      id: feeds.id,
      couchDbName: feeds.couchDbName,
      cacheImages: feeds.cacheImages,
      maxImageCount: feeds.maxImageCount,
      maxImageWidth: feeds.maxImageWidth,
      avifQuality: feeds.avifQuality,
      maxSourceImageBytes: feeds.maxSourceImageBytes,
    }).from(feeds)
    for (const r of rows) {
      if (!r.couchDbName) continue
      map.set(r.couchDbName, {
        feedId: r.id,
        cacheImages: r.cacheImages,
        maxImageCount: r.maxImageCount,
        maxImageWidth: r.maxImageWidth,
        avifQuality: r.avifQuality,
        maxSourceImageBytes: r.maxSourceImageBytes,
      })
    }
    console.log(`已读取 PostgreSQL 中 ${rows.length} 条 feed 配置（其中 ${map.size} 条有库名）`)
  } catch (err) {
    console.warn(`⚠️  读取 feed 配置失败，全部按全局默认 ${DEFAULT_MAX_IMAGE_COUNT} 张判定：${(err as Error).message}`)
  }
  return map
}

/** 该库每篇允许缓存的张数（Infinity 表示不限量） */
function effectiveLimit(cfg: FeedConfig | undefined): number {
  if (cfg?.cacheImages === true && cfg.maxImageCount == null) return Number.POSITIVE_INFINITY
  return cfg?.maxImageCount ?? DEFAULT_MAX_IMAGE_COUNT
}

// ── 单条目判定 ──

function classifyDoc(doc: Record<string, unknown>, dbName: string, cfg: FeedConfig | undefined): void {
  const id = String(doc._id ?? "")
  if (doc.type !== "entry") {
    stats.skippedDocs++
    return
  }
  stats.entryDocs++

  const content = typeof doc.content === "string" ? doc.content : ""
  const baseUrl = typeof doc.url === "string" ? doc.url : ""
  // 与抓取时同口径：去重 + 相对路径绝对化；上限给足以便算出「正文一共有几张图」
  const expectedUrls = content ? extractImageUrls(content, baseUrl, 1_000_000) : []
  const expected = expectedUrls.length

  const images = Array.isArray(doc.images) ? (doc.images as Array<Record<string, unknown>>) : []
  const atts = (doc._attachments ?? {}) as Record<string, { length?: number }>
  const attNames = Object.keys(atts)

  // 附件体积（压缩后真实字节）
  let docAttBytes = 0
  for (const name of attNames) {
    const len = atts[name]?.length ?? 0
    stats.attBytes.push(len)
    stats.attCount++
    docAttBytes += len
  }
  if (attNames.length > 0) stats.entryAttBytes.push(docAttBytes)

  // images 里引用了不存在的附件 → 断链
  const validCached = images.filter((i) => typeof i.attachment === "string" && atts[i.attachment as string])
  const broken = images.length - validCached.length
  stats.brokenRefs += broken
  if (images.length === 0 && attNames.length > 0) stats.attsWithoutImages++

  const cached = validCached.length
  const limit = effectiveLimit(cfg)
  const capped = Math.min(expected, limit)

  const insertedAt = String(doc.insertedAt ?? doc.publishedAt ?? "")
  const month = insertedAt ? insertedAt.slice(0, 7) : "unknown"

  const b = stats.byMonth.get(month) ?? emptyBucket()
  b.entries++
  const target = insertedAt && insertedAt.slice(0, 10) < CACHE_CUTOVER ? stats.beforeCutover : stats.afterCutover
  target.entries++

  if (expected === 0) {
    if (cached > 0) {
      stats.coverOnly++
      target.full++
      b.full++
      const bucket = stats.buckets.get("0") ?? { entries: 0, expected: 0, cached: 0, truncated: 0 }
      bucket.entries++
      bucket.cached += cached
      stats.buckets.set("0", bucket)
    } else {
      stats.noImg++
      target.noImg++
      b.noImg++
    }
    stats.byMonth.set(month, b)
    return
  }

  // 正文有图
  const bk = bucketKey(expected)
  const bucket = stats.buckets.get(bk) ?? { entries: 0, expected: 0, cached: 0, truncated: 0 }
  bucket.entries++
  bucket.expected += expected
  bucket.cached += cached
  if (expected > limit) {
    bucket.truncated++
    stats.truncatedEntries++
    if (cached === limit) stats.truncatedAtLimit++
  }
  stats.buckets.set(bk, bucket)

  if (cached >= capped) {
    stats.full++
    target.full++
    b.full++
  } else if (cached > 0) {
    stats.partial++
    target.partial++
    b.partial++
    pushSample("partial", id, baseUrl, expected, cached, limit, insertedAt, dbName, expectedUrls)
  } else {
    stats.none++
    target.none++
    b.none++
    pushSample("none", id, baseUrl, expected, cached, limit, insertedAt, dbName, expectedUrls)
  }
  stats.byMonth.set(month, b)

  // 预算策略模拟用：正文有图条目记下「原文图数 + 实际缓存的附件体积序列」
  if (SIMULATE) {
    stats.profiles.push({
      expected,
      sizes: validCached.map((i) => atts[i.attachment as string]?.length ?? 0).filter((n) => n > 0),
    })
  }
}

/** 收集失败样例（上限 400 条，供报告展示与 --probe 抽样探测） */
function pushSample(
  kind: "none" | "partial",
  id: string, url: string, expected: number, cached: number, limit: number,
  insertedAt: string, db: string, urls: string[],
): void {
  if (stats.samples.length >= 400) return
  stats.samples.push({
    id, url, expected, cached,
    limit, insertedAt, db, kind,
    // 只留前 8 张原图，够探测用又不占内存
    urls: urls.slice(0, 8),
  })
}

// ── 失败原因探测（可选，--probe=N） ──

interface ProbeRow {
  url: string
  status: number | null
  type: string
  len: number
  ms: number
  error?: string
}

const UA = "Mozilla/5.0 (compatible; rssfed/1.0)"

/** 对单个原图 URL 做轻量头部探测（HEAD；不支持 HEAD 时用 Range GET 并立刻取消 body） */
async function probeOne(url: string): Promise<ProbeRow> {
  const t0 = Date.now()
  try {
    let res = await fetch(url, {
      method: "HEAD", redirect: "follow",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET", redirect: "follow",
        headers: { "User-Agent": UA, Range: "bytes=0-0" },
        signal: AbortSignal.timeout(10_000),
      })
      // 只要响应头，别把图拉下来
      try { await res.body?.cancel() } catch { /* 忽略 */ }
    }
    const raw = res.headers.get("content-length")
    const len = raw ? Number(raw) : 0
    return {
      url,
      status: res.status,
      type: (res.headers.get("content-type") ?? "").toLowerCase(),
      len: Number.isFinite(len) ? len : 0,
      ms: Date.now() - t0,
    }
  } catch (err) {
    return { url, status: null, type: "", len: 0, ms: Date.now() - t0, error: (err as Error).message }
  }
}

async function probeFailures(): Promise<{ rows: ProbeRow[], entries: number }> {
  // 完全未命中的条目优先（最极端），每条最多取 4 个原图 URL
  const picked = [...stats.samples]
    .sort((a, b) => (a.kind === "none" ? 0 : 1) - (b.kind === "none" ? 0 : 1))
    .slice(0, PROBE_N)
  const urls: string[] = []
  for (const s of picked) {
    for (const u of s.urls.slice(0, 4)) {
      if (!urls.includes(u)) urls.push(u)
    }
  }
  console.log(`探测 ${picked.length} 条失败条目的 ${urls.length} 个原图 URL（并发 ${PROBE_CONCURRENCY}）…`)
  const rows: ProbeRow[] = new Array(urls.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < urls.length) {
      const i = cursor++
      rows[i] = await probeOne(urls[i]!)
      if ((i + 1) % 20 === 0) console.log(`  …已探测 ${i + 1}/${urls.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, worker))
  return { rows, entries: picked.length }
}

/** 把探测结果分到互斥的原因桶里 */
function probeReason(r: ProbeRow): string {
  if (r.error) return "网络错误/超时"
  if (r.status === 403 || r.status === 401) return "403/401 防盗链或拒绝"
  if (r.status === 404 || r.status === 410) return "404/410 已下线"
  if (r.status == null || r.status >= 400) return `其它 HTTP 错误（${r.status ?? "?"}）`
  if (!r.type.startsWith("image/")) return `Content-Type 非 image/*（${r.type || "无"}）`
  if (r.len > MAX_SOURCE_BYTES) return `源图字节超上限（>${fmtBytes(MAX_SOURCE_BYTES)}）`
  if (r.len === 0) return "无 Content-Length（无法判定体积）"
  return "本应可缓存（200 + image/* + 未超上限）"
}

// ── 报告 ──

interface SimRow {
  label: string
  budget: number
  images: number
  bytes: number
  truncatedEntries: number
  entries: number
}

/**
 * 模拟「每篇附件总体积预算」策略。
 *
 * 规则：按正文出现顺序累计压缩后体积，累计超预算即停止缓存后续图片；第一张总是保留
 * （与现有「协议封面/首图必缓存」的语义一致，否则一张 700KB 的大图会让整篇没图）。
 *
 * 单张体积取自该条目**已缓存附件**的实测体积并循环取样 —— 同篇文章的图片尺寸/细节
 * 通常相近，比从全局分布随机抽样更接近真实。
 */
function simulateBudgets(): SimRow[] {
  const all: number[] = []
  for (const p of stats.profiles) all.push(...p.sizes)
  all.sort((a, b) => a - b)
  const median = all.length > 0 ? all[Math.floor(all.length / 2)]! : 20_000

  const budgets = [64, 128, 256, 512, 1024, 2048, 4096].map((kb) => kb * 1024)
  const rows: SimRow[] = []
  for (const budget of budgets) {
    let images = 0, bytes = 0, truncated = 0
    for (const p of stats.profiles) {
      const sizes = p.sizes.length > 0 ? p.sizes : [median]
      let acc = 0, n = 0
      for (let i = 0; i < p.expected; i++) {
        const sz = sizes[i % sizes.length]!
        if (n > 0 && acc + sz > budget) break // 首图必留，之后超预算即停
        acc += sz
        n++
      }
      images += n
      bytes += acc
      if (n < p.expected) truncated++
    }
    rows.push({ label: fmtBytes(budget), budget, images, bytes, truncatedEntries: truncated, entries: stats.profiles.length })
  }
  return rows
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%"
  return `${((n / total) * 100).toFixed(1)}%`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(2)}MB`
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]!
}

function report(durationMs: number, cfgCount: number, cfgMap: Map<string, FeedConfig>, probe: { rows: ProbeRow[], entries: number } | null): void {
  const lines: string[] = []
  const log = (s = "") => { lines.push(s); console.log(s) }

  const withImg = stats.full + stats.partial + stats.none
  const failed = stats.partial + stats.none

  log("════════════ RSSFed 正文图片缓存诊断 ════════════")
  log(`扫描 ${stats.dbs} 个 feed 库（失败 ${stats.dbErrors}），耗时 ${(durationMs / 1000).toFixed(1)}s`)
  log(`条目文档 ${stats.entryDocs} 个（跳过非条目文档 ${stats.skippedDocs}）`)
  log()

  log("【一、条目的图片缓存状态】")
  log(`  正文无图（不适用）              ${String(stats.noImg).padStart(7)}  ${pct(stats.noImg, stats.entryDocs)}`)
  log(`  仅有协议封面、正文无图          ${String(stats.coverOnly).padStart(7)}  ${pct(stats.coverOnly, stats.entryDocs)}`)
  log(`  完整命中（策略内全部缓存）      ${String(stats.full).padStart(7)}  ${pct(stats.full, stats.entryDocs)}`)
  log(`  部分命中（本该多缓存却失败）    ${String(stats.partial).padStart(7)}  ${pct(stats.partial, stats.entryDocs)}`)
  log(`  完全未命中（正文有图，0 张）    ${String(stats.none).padStart(7)}  ${pct(stats.none, stats.entryDocs)}`)
  log(`  ── 有图条目合计 ${withImg}，其中失败 ${failed}（${pct(failed, withImg)}）`)
  log(`  images 引用缺失附件（断链）     ${String(stats.brokenRefs).padStart(7)}`)
  log(`  有附件却无 images 字段          ${String(stats.attsWithoutImages).padStart(7)}`)
  log()

  log("【二、失败条目的时间分布】（区分历史遗留与新增失败）")
  log("  月份        条目数     完整     部分     未命中   失败率")
  const months = [...stats.byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [month, b] of months) {
    const withImgB = b.full + b.partial + b.none
    const failB = b.partial + b.none
    log(`  ${month.padEnd(10)} ${String(b.entries).padStart(7)} ${String(b.full).padStart(8)} ${String(b.partial).padStart(8)} ${String(b.none).padStart(9)}   ${pct(failB, withImgB)}`)
  }
  const bc = stats.beforeCutover
  const ac = stats.afterCutover
  const bcImg = bc.full + bc.partial + bc.none
  const acImg = ac.full + ac.partial + ac.none
  log()
  log(`  上线前（<${CACHE_CUTOVER}）：条目 ${bc.entries}，有图 ${bcImg}，失败 ${bc.partial + bc.none}（${pct(bc.partial + bc.none, bcImg)}）`)
  log(`  上线后（>=${CACHE_CUTOVER}）：条目 ${ac.entries}，有图 ${acImg}，失败 ${ac.partial + ac.none}（${pct(ac.partial + ac.none, acImg)}）`)
  log()

  log("【三、正文图数量 vs 命中情况】（验证「每篇 5 张上限」的影响）")
  log("  正文图数   条目数    策略外截断   应缓存   实缓存   总命中率")
  const order = ["0", "1", "2", "3", "4", "5", "6-10", "11-20", ">20"]
  for (const key of order) {
    const b = stats.buckets.get(key)
    if (!b) continue
    const rate = b.expected === 0 ? "—" : pct(b.cached, b.expected)
    log(`  ${key.padEnd(9)} ${String(b.entries).padStart(7)} ${String(b.truncated).padStart(11)} ${String(b.expected).padStart(8)} ${String(b.cached).padStart(8)}   ${rate}`)
  }
  log()
  log(`  正文图数超过策略上限的条目：${stats.truncatedEntries}（其中 ${stats.truncatedAtLimit} 条缓存数正好等于上限 = 正常截断；其余 ${stats.truncatedEntries - stats.truncatedAtLimit} 条连上限都没填满）`)
  log()

  const attSorted = [...stats.attBytes].sort((a, b) => a - b)
  const entrySorted = [...stats.entryAttBytes].sort((a, b) => a - b)
  const totalAtt = attSorted.reduce((a, b) => a + b, 0)
  log("【四、附件体积】（压缩后写入 CouchDB 的真实字节）")
  log(`  已缓存附件 ${stats.attCount} 个，合计 ${fmtBytes(totalAtt)}`)
  if (attSorted.length > 0) {
    log(`  单附件 p50=${fmtBytes(quantile(attSorted, 0.5))} p90=${fmtBytes(quantile(attSorted, 0.9))} p99=${fmtBytes(quantile(attSorted, 0.99))} max=${fmtBytes(attSorted[attSorted.length - 1]!)}`)
    log(`  超 1MB 的附件 ${attSorted.filter((x) => x > 1048576).length} 个，超 4MB ${attSorted.filter((x) => x > 4194304).length} 个，超 8MB ${attSorted.filter((x) => x > 8388608).length} 个`)
  }
  if (entrySorted.length > 0) {
    log(`  单条目附件合计 p50=${fmtBytes(quantile(entrySorted, 0.5))} p90=${fmtBytes(quantile(entrySorted, 0.9))} max=${fmtBytes(entrySorted[entrySorted.length - 1]!)}`)
  }
  log()

  log("【五、per-feed 策略覆盖】")
  let cacheAll = 0, overrideCount = 0, widthOverride = 0, bytesOverride = 0
  for (const cfg of cfgMap.values()) {
    if (cfg.cacheImages === true) cacheAll++
    if (cfg.maxImageCount != null) overrideCount++
    if (cfg.maxImageWidth != null) widthOverride++
    if (cfg.maxSourceImageBytes != null) bytesOverride++
  }
  log(`  PostgreSQL 中 feed 记录 ${cfgCount} 条（有库名 ${cfgMap.size}）`)
  log(`  cacheImages=true（不限量）${cacheAll}；覆盖 maxImageCount ${overrideCount}；覆盖 maxImageWidth ${widthOverride}；覆盖 maxSourceImageBytes ${bytesOverride}`)
  log()

  if (stats.samples.length > 0) {
    log(`【六、失败样例】（共收集 ${stats.samples.length} 条，最多展示 ${SAMPLE_N} 条）`)
    const shown = [...stats.samples].sort((a, b) => b.expected - a.expected).slice(0, SAMPLE_N)
    for (const s of shown) {
      const tag = s.kind === "none" ? "全失败" : `部分 ${s.cached}`
      log(`  正文 ${String(s.expected).padStart(3)} 张 / 上限 ${s.limit === Number.POSITIVE_INFINITY ? "∞" : s.limit} | ${tag} | ${s.insertedAt.slice(0, 10)} | ${s.url || "(无 url)"}`)
    }
    log()
  }

  if (probe) {
    const counts = new Map<string, number>()
    for (const r of probe.rows) {
      const key = probeReason(r)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    log(`【七、失败原因抽样探测】（${probe.entries} 条失败条目的 ${probe.rows.length} 个原图 URL；源图上限 ${fmtBytes(MAX_SOURCE_BYTES)}）`)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    for (const [reason, n] of sorted) {
      log(`  ${reason.padEnd(38)} ${String(n).padStart(5)}  ${pct(n, probe.rows.length)}`)
    }
    const overLimit = probe.rows.filter((r) => r.status === 200 && r.type.startsWith("image/") && r.len > MAX_SOURCE_BYTES)
    if (overLimit.length > 0) {
      log(`  超上限样例：`)
      for (const r of overLimit.slice(0, 5)) log(`    ${fmtBytes(r.len)}  ${r.url}`)
    }
    const wouldSucceed = probe.rows.filter((r) => probeReason(r).startsWith("本应可缓存"))
    if (wouldSucceed.length > 0) {
      log(`  「本应可缓存」样例（说明失败另有原因，如像素超限/压缩失败）：`)
      for (const r of wouldSucceed.slice(0, 5)) log(`    ${r.status} ${fmtBytes(r.len)} ${r.type}  ${r.url}`)
    }
    log()
  }

  let simRows: SimRow[] | null = null
  if (SIMULATE && stats.profiles.length > 0) {
    simRows = simulateBudgets()
    const totalExpected = stats.profiles.reduce((a, p) => a + p.expected, 0)
    let baseImages = 0
    for (const [k, b] of stats.buckets) {
      if (k !== "0") baseImages += b.cached
    }
    log("【八、按「每篇附件体积预算」策略模拟】")
    log("  口径：压缩后附件体积；按正文顺序累计，首图必留，累计超预算即停止缓存后续图片")
    log(`  基线：当前「每篇 5 张」→ 缓存 ${baseImages} 张，覆盖率 ${pct(baseImages, totalExpected)}，被截断 ${stats.truncatedEntries} 条`)
    log()
    log("  每篇预算     可存张数   覆盖率    压缩后总量    被截断条目")
    for (const r of simRows) {
      log(`  ${r.label.padEnd(11)} ${String(r.images).padStart(8)}   ${pct(r.images, totalExpected).padStart(6)}   ${fmtBytes(r.bytes).padStart(10)}   ${String(r.truncatedEntries).padStart(8)}`)
    }
    log()
  } else if (SIMULATE) {
    log("【八、预算策略模拟】未收集到正文有图的条目，跳过")
    log()
  }

  const outDir = path.resolve(import.meta.dirname, "../../../report/image-cache-diagnosis")
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, "result.txt"), lines.join("\n") + "\n")
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({
    scanned: { dbs: stats.dbs, dbErrors: stats.dbErrors, entryDocs: stats.entryDocs, skippedDocs: stats.skippedDocs },
    status: {
      noImg: stats.noImg, coverOnly: stats.coverOnly, full: stats.full,
      partial: stats.partial, none: stats.none, brokenRefs: stats.brokenRefs,
      attsWithoutImages: stats.attsWithoutImages,
    },
    cutover: { before: stats.beforeCutover, after: stats.afterCutover, date: CACHE_CUTOVER },
    buckets: Object.fromEntries([...stats.buckets.entries()]),
    byMonth: Object.fromEntries([...stats.byMonth.entries()]),
    attachments: {
      count: stats.attCount, totalBytes: totalAtt,
      p50: quantile(attSorted, 0.5), p90: quantile(attSorted, 0.9), p99: quantile(attSorted, 0.99),
      max: attSorted[attSorted.length - 1] ?? 0,
      over1MB: attSorted.filter((x) => x > 1048576).length,
      over8MB: attSorted.filter((x) => x > 8388608).length,
    },
    truncation: { entriesOverLimit: stats.truncatedEntries, cachedExactlyAtLimit: stats.truncatedAtLimit },
    perFeedConfig: { total: cfgCount, withDbName: cfgMap.size, cacheAll, maxImageCountOverride: overrideCount, maxImageWidthOverride: widthOverride, maxSourceImageBytesOverride: bytesOverride },
    samples: stats.samples.slice(0, 50),
    simulation: simRows,
    probe: probe
      ? {
          entries: probe.entries,
          urls: probe.rows.length,
          reasons: (() => {
            const m = new Map<string, number>()
            for (const r of probe.rows) {
              const k = probeReason(r)
              m.set(k, (m.get(k) ?? 0) + 1)
            }
            return Object.fromEntries(m)
          })(),
          rows: probe.rows.slice(0, 200),
        }
      : null,
  }, null, 2))
  console.log(`\n报告已写入：${path.relative(process.cwd(), outDir)}/result.{txt,json}`)
}

// ── 主流程 ──

async function main(): Promise<void> {
  const t0 = Date.now()
  console.log("读取 feed 配置 …")
  const cfgMap = await loadFeedConfigs()
  const cfgCount = cfgMap.size

  console.log("列出 feed 库 …")
  const dbNames = await listFeedDbs()
  stats.dbs = dbNames.length
  console.log(`发现 ${dbNames.length} 个 feed 库，并发 ${CONCURRENCY} 只读扫描 …`)

  const queue = [...dbNames]
  let processed = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const dbName = queue.shift()!
      const cfg = cfgMap.get(dbName)
      try {
        await scanDb(dbName, (doc) => {
          stats.docs++
          classifyDoc(doc, dbName, cfg)
        })
      } catch (err) {
        stats.dbErrors++
        console.warn(`  ⚠️  ${dbName} 扫描失败：${(err as Error).message}`)
      }
      processed++
      if (processed % 100 === 0) console.log(`  …已扫描 ${processed}/${dbNames.length} 个库`)
    }
  })
  await Promise.all(workers)

  const probe = PROBE_N > 0 ? await probeFailures() : null
  report(Date.now() - t0, cfgCount, cfgMap, probe)
  process.exit(0)
}

main().catch((err) => {
  console.error("❌ 诊断失败:", err)
  process.exit(1)
})
