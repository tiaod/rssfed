import type { DocumentScope } from "nano"
import { eq } from "drizzle-orm"
import { db, user, userTimelineSettings, type CachedImage, type NewUserTimelineSettings } from "../db"
import {
  createCouchDb,
  ensureBotDatabase,
  ensureFeedDatabase,
  ensureTimelineDatabase,
  ensureUserStateDatabase,
  nanoServer,
} from "../couchdb/client"
import { DEFAULT_IMAGE_OPTIONS, cacheEntryImages, type EntryImageOptions, type ImageAttachment } from "../rss/entry-images"

/**
 * 用户时间线聚合服务：把用户订阅的 feed / bot 增量聚合进他自己的 CouchDB 派生库。
 *
 * 为什么是「拉」而不是在抓取时扇出：
 *   订阅关系**只**存在于各用户的 user-state 库（客户端离线也能改，见 ARCHITECTURE.md），
 *   PostgreSQL 里没有「谁订阅了什么」的表。抓取时扇出就得先引入这样一张索引表（或监听
 *   每个 user-state 库的 _changes）才能知道该推给谁；而按用户拉只需要读他自己的订阅列表，
 *   与既有代码（listSubscriptionsForUser）同源，没有额外状态需要维护。
 *
 * 成本闸门全在「一条 SQL」上：只有该用户订阅的源里 `lastNewEntryAt > 自己的游标` 的那些
 * 才会去碰 CouchDB（见 changedSourceIds）。没有新内容的用户，整轮 reconcile 只有
 * 1 次 user-state 库读取 + 1 次用户时间线库的状态文档读取。
 *
 * 触发方：定时任务（workers/timeline.ts，默认 5 分钟）+ 客户端主动刷新
 * （POST /api/timeline/refresh，订阅/退订后调用）。
 */

// ── 每用户设置 ──

/** 时间线聚合设置（用户可调；图片参数与 per-feed 那套同名同义） */
export interface TimelineSettings {
  /** 回填窗口天数；0 = 不限时间 */
  windowDays: number
  /** 每篇条目最多缓存几张正文图 */
  maxImageCount: number
  /** 每篇条目附件总体积上限字节 */
  maxEntryImageBytes: number
  /** 压缩后最大宽度 px */
  maxImageWidth: number
  /** AVIF 编码质量 */
  avifQuality: number
  /** 源图下载大小上限字节 */
  maxSourceImageBytes: number
  /** 是否生成 AI 摘要（本轮只落存储位与文档字段，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 缺省值：图片参数直接复用 feed 库那套全局默认，保证「同一个源在两个库里看到的图一致」 */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  windowDays: 3,
  maxImageCount: DEFAULT_IMAGE_OPTIONS.maxImageCount,
  maxEntryImageBytes: DEFAULT_IMAGE_OPTIONS.maxEntryImageBytes,
  maxImageWidth: DEFAULT_IMAGE_OPTIONS.maxImageWidth,
  avifQuality: DEFAULT_IMAGE_OPTIONS.avifQuality,
  maxSourceImageBytes: DEFAULT_IMAGE_OPTIONS.maxSourceImageBytes,
  aiSummaryEnabled: false,
}

/** 各设置项的合法区间（路由/服务共用，避免两处各写一份校验） */
export const TIMELINE_SETTING_LIMITS = {
  windowDays: { min: 0, max: 365 },
  maxImageCount: { min: 0, max: 500 },
  maxEntryImageBytes: { min: 0, max: 32 * 1024 * 1024 },
  maxImageWidth: { min: 64, max: 4096 },
  avifQuality: { min: 1, max: 100 },
  maxSourceImageBytes: { min: 64 * 1024, max: 64 * 1024 * 1024 },
} as const

/** PG 行（或缺失）→ 有效设置：null 一律回退全局默认 */
export function normalizeTimelineSettings(row: Partial<Record<keyof TimelineSettings, unknown>> | null | undefined): TimelineSettings {
  const pick = (key: keyof TimelineSettings, fallback: number): number => {
    const raw = row?.[key]
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback
  }
  return {
    windowDays: pick("windowDays", DEFAULT_TIMELINE_SETTINGS.windowDays),
    maxImageCount: pick("maxImageCount", DEFAULT_TIMELINE_SETTINGS.maxImageCount),
    maxEntryImageBytes: pick("maxEntryImageBytes", DEFAULT_TIMELINE_SETTINGS.maxEntryImageBytes),
    maxImageWidth: pick("maxImageWidth", DEFAULT_TIMELINE_SETTINGS.maxImageWidth),
    avifQuality: pick("avifQuality", DEFAULT_TIMELINE_SETTINGS.avifQuality),
    maxSourceImageBytes: pick("maxSourceImageBytes", DEFAULT_TIMELINE_SETTINGS.maxSourceImageBytes),
    aiSummaryEnabled: row?.aiSummaryEnabled === true,
  }
}

/**
 * 校验客户端提交的设置补丁（纯函数，供路由与单测复用）。
 *
 * 越界/类型错误一律报错而不是静默夹取：图片参数直接决定服务端要下载压缩多少张图，
 * 「以为设成 5 结果被当成 500」这种静默纠正在排查时毫无信号。
 */
export function parseTimelineSettingsPatch(raw: unknown): { patch: Partial<TimelineSettings>, errors: string[] } {
  const errors: string[] = []
  const patch: Partial<TimelineSettings> = {}
  if (raw === null || typeof raw !== "object") {
    return { patch, errors: ["请求体必须是对象"] }
  }
  const input = raw as Record<string, unknown>
  const intKeys: Array<keyof typeof TIMELINE_SETTING_LIMITS> = [
    "windowDays", "maxImageCount", "maxEntryImageBytes", "maxImageWidth", "avifQuality", "maxSourceImageBytes",
  ]
  for (const key of intKeys) {
    if (!(key in input)) continue
    const value = input[key]
    const { min, max } = TIMELINE_SETTING_LIMITS[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} 需为 ${min}..${max} 的整数`)
      continue
    }
    patch[key] = value
  }
  if ("aiSummaryEnabled" in input) {
    if (typeof input.aiSummaryEnabled !== "boolean") errors.push("aiSummaryEnabled 需为布尔值")
    else patch.aiSummaryEnabled = input.aiSummaryEnabled
  }
  return { patch, errors }
}

/** 图片参数是否变化（变化后已聚合的条目仍带旧参数的附件，需要重建才能生效） */
export function imageParamsChanged(before: TimelineSettings, after: TimelineSettings): boolean {
  return before.maxImageCount !== after.maxImageCount
    || before.maxEntryImageBytes !== after.maxEntryImageBytes
    || before.maxImageWidth !== after.maxImageWidth
    || before.avifQuality !== after.avifQuality
    || before.maxSourceImageBytes !== after.maxSourceImageBytes
}

/** 读取用户的时间线设置（没有行 = 全部全局默认） */
export async function getTimelineSettings(userId: string): Promise<TimelineSettings> {
  const [row] = await db.select().from(userTimelineSettings)
    .where(eq(userTimelineSettings.userId, userId)).limit(1)
  return normalizeTimelineSettings(row ?? null)
}

/**
 * 写入用户的时间线设置（UPSERT），返回生效后的设置与「是否需要重建」。
 *
 * 只改窗口不需要重建：窗口是「回填/剪枝」的边界，由 reconcile 自己处理（缩小剪枝、
 * 放大回填）。改图片参数必须重建 —— 已聚合条目的附件是按旧参数压的，逐条重压不如
 * 直接把派生库丢掉重算（库名置空 + 下次 reconcile 全量回填，见 rebuildUserTimeline）。
 */
export async function updateTimelineSettings(
  userId: string,
  patch: Partial<TimelineSettings>,
): Promise<{ settings: TimelineSettings, needsRebuild: boolean }> {
  const before = await getTimelineSettings(userId)
  const values: NewUserTimelineSettings = { userId }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    Object.assign(values, { [key]: value })
  }
  await db.insert(userTimelineSettings)
    .values(values)
    .onConflictDoUpdate({
      target: userTimelineSettings.userId,
      set: { ...values, updatedAt: new Date() },
    })
  const after = await getTimelineSettings(userId)
  return { settings: after, needsRebuild: imageParamsChanged(before, after) }
}

// ── 窗口 ──

/** 窗口下界（ISO）；windowDays <= 0 返回 null = 不限时间 */
export function windowStartIso(windowDays: number, now: number = Date.now()): string | null {
  if (windowDays <= 0) return null
  return new Date(now - windowDays * 86_400_000).toISOString()
}

/** 条目是否在窗口内（发布时间缺失/不可解析视为不在窗口内，与客户端 Mango selector 的行为一致） */
function inWindow(doc: { publishedAt?: unknown }, windowStart: string | null): boolean {
  if (!windowStart) return true
  if (typeof doc.publishedAt !== "string") return false
  const ms = Date.parse(doc.publishedAt)
  return Number.isFinite(ms) && ms >= Date.parse(windowStart)
}

// ── 源 ──

export interface TimelineSource {
  /** 源 id：feedId 或 `bot:{botId}` */
  id: string
  kind: "feed" | "bot"
}

/** 读取用户的订阅源集合（只读 user-state 库的 subscription 文档，不查 PG 注册表） */
export async function listSubscriptionSources(userId: string): Promise<TimelineSource[]> {
  const userDb = createCouchDb(await ensureUserStateDatabase(userId))
  const { rows } = await userDb.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  const seen = new Set<string>()
  const sources: TimelineSource[] = []
  for (const row of rows) {
    const doc = row.doc as { feedId?: unknown, kind?: unknown } | undefined
    const feedId = doc?.feedId
    // 脏订阅文档防御（与 listSubscriptionsForUser 同规则）：空 feedId 定位不到任何库
    if (typeof feedId !== "string" || feedId.length === 0 || seen.has(feedId)) continue
    seen.add(feedId)
    sources.push({ id: feedId, kind: doc?.kind === "bot" ? "bot" : "feed" })
  }
  return sources
}

/** 源 id → 源库 DocumentScope（bot 订阅读 bot 产出库） */
async function resolveSourceScope(source: TimelineSource): Promise<DocumentScope<unknown>> {
  if (source.kind === "bot") return createCouchDb(await ensureBotDatabase(source.id.slice("bot:".length)))
  return createCouchDb(await ensureFeedDatabase(source.id))
}

/** 源 id 对应的条目 `_id` 前缀（退订时按它做范围删除） */
export function entryIdPrefix(sourceId: string): string {
  return sourceId.startsWith("bot:")
    ? `entry:bot:${sourceId.slice("bot:".length)}:`
    : `entry:${sourceId}:`
}

// ── 状态文档（`_local/state`） ──
//
// 放 `_local/` 而不是普通文档：`_local` 文档**不参与复制**，所以浏览器不会同步到
// 「服务端记到哪了」这种纯内部状态；同时它随派生库一起删除，重建即重来。

const STATE_DOC_ID = "_local/state"

interface TimelineSourceState {
  /** 该源 `_changes` 的游标（CouchDB 3 是字符串 seq）；null 表示还没扫过 */
  cursor: string | number | null
  /** 首次聚合时间（诊断用） */
  addedAt?: string
}

interface TimelineState {
  version: number
  /** 上次 reconcile 生效的窗口天数，用来判断窗口是放大还是缩小 */
  windowDays: number | null
  settingsUpdatedAt: string | null
  sources: Record<string, TimelineSourceState>
}

function emptyState(): TimelineState {
  return { version: 1, windowDays: null, settingsUpdatedAt: null, sources: {} }
}

/** 读状态文档；不存在（首次）返回空状态 */
async function readTimelineState(dbName: string): Promise<TimelineState> {
  try {
    const doc = await nanoServer.request({ db: dbName, doc: STATE_DOC_ID, method: "GET" }) as Partial<TimelineState>
    return {
      version: 1,
      windowDays: typeof doc.windowDays === "number" ? doc.windowDays : null,
      settingsUpdatedAt: typeof doc.settingsUpdatedAt === "string" ? doc.settingsUpdatedAt : null,
      sources: doc.sources && typeof doc.sources === "object" ? doc.sources : {},
    }
  } catch {
    return emptyState()
  }
}

/** 写状态文档（`_local` 文档必须走 PUT /db/_local/state，不能用 insert） */
async function writeTimelineState(dbName: string, state: TimelineState): Promise<void> {
  // 冲突（同用户的两次 reconcile 撞车）就地重读一次 rev 再写：状态文档丢了不影响正确性，
  // 但会让下一轮把全部源重新扫一遍，代价不小，值得重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let rev: string | undefined
    try {
      const existing = await nanoServer.request({ db: dbName, doc: STATE_DOC_ID, method: "GET" }) as { _rev?: string }
      rev = existing?._rev
    } catch {
      // 首次写：没有 _rev
    }
    try {
      await nanoServer.request({
        db: dbName,
        doc: STATE_DOC_ID,
        method: "PUT",
        body: rev ? { ...state, _rev: rev } : state,
      })
      return
    } catch (err) {
      if (attempt === 1) throw err
    }
  }
}

// ── 写入派生库 ──

type TimelineDoc = Record<string, unknown> & { _id: string }

/** 由源条目构造派生库里的条目文档：换掉附件与 images，其余字段原样保留 */
export function toTimelineEntryDoc(
  sourceDoc: Record<string, unknown>,
  images: CachedImage[],
  attachments: ImageAttachment[],
): TimelineDoc {
  // `_rev` 不能带过去（派生库里是另一份文档）；源库的附件也不复用（按用户参数重新生成的）
  const { _rev: _omitRev, _attachments: _omitAttachments, _revisions: _omitRevisions, ...rest } = sourceDoc
  const doc: TimelineDoc = { ...rest, _id: String(sourceDoc._id) }
  if (images.length > 0) doc.images = images
  else Reflect.deleteProperty(doc, "images")
  if (attachments.length > 0) {
    doc._attachments = Object.fromEntries(
      attachments.map(a => [a.name, { content_type: a.content_type, data: a.data.toString("base64") }]),
    )
  }
  return doc
}

/** 源条目里作为「协议封面」的图片 URL（供 cacheEntryImages 优先选它作图 0） */
export function sourceCoverUrl(sourceDoc: Record<string, unknown>): string | undefined {
  const images = sourceDoc.images
  if (!Array.isArray(images)) return undefined
  const cover = images.find((img): img is CachedImage =>
    !!img && typeof img === "object" && (img as CachedImage).cover === true && typeof (img as CachedImage).url === "string")
  return cover?.url
}

/** 设置 → cacheEntryImages 的图片策略 */
function imageOptions(settings: TimelineSettings): EntryImageOptions {
  return {
    maxImageCount: settings.maxImageCount,
    maxEntryImageBytes: settings.maxEntryImageBytes,
    maxImageWidth: settings.maxImageWidth,
    avifQuality: settings.avifQuality,
    maxSourceImageBytes: settings.maxSourceImageBytes,
  }
}

/**
 * 把源条目写进派生库（只写库里还没有的）。
 *
 * 「先查存在性再写」这一步不能省：`_bulk_docs` 的 `_attachments` 是 base64 内联的，
 * 对一条库里已有、只是再次被扫到的条目重传附件是纯浪费（回填/游标回退时会大量出现）。
 */
export async function writeEntries(
  scope: DocumentScope<unknown>,
  sourceDocs: Array<Record<string, unknown>>,
  settings: TimelineSettings,
): Promise<{ written: number, imageFailures: number }> {
  const entries = sourceDocs.filter(doc => doc.type === "entry" && typeof doc._id === "string")
  if (entries.length === 0) return { written: 0, imageFailures: 0 }

  const existing = await fetchExistingIds(scope, entries.map(doc => String(doc._id)))
  const fresh = entries.filter(doc => !existing.has(String(doc._id)))
  if (fresh.length === 0) return { written: 0, imageFailures: 0 }

  // 条目之间限并发（每条目**内部**仍是串行，预算判断的顺序因此保持确定）：
  // 占大头的等待是「坏图床的 10s 超时」，并发只是让这些等待重叠，不改变写入内容。
  const docs: TimelineDoc[] = new Array<TimelineDoc>(fresh.length)
  let imageFailures = 0
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= fresh.length) return
      const sourceDoc = fresh[index]!
      const { images, attachments, stats } = await cacheEntryImages(
        typeof sourceDoc.content === "string" ? sourceDoc.content : undefined,
        typeof sourceDoc.url === "string" ? sourceDoc.url : "",
        sourceCoverUrl(sourceDoc),
        imageOptions(settings),
      )
      // stats.failed 的累加不需要原子性：JS 单线程，+= 之间没有 await
      imageFailures += stats.failed
      docs[index] = toTimelineEntryDoc(sourceDoc, images, attachments)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ENTRY_WRITE_CONCURRENCY, fresh.length) }, () => worker()),
  )

  const results = await scope.bulk({ docs })
  // 409（同一轮里重复扫到 / 与别的 worker 撞车）不算失败：库里已经有这条了就达到目的
  const written = results.filter(r => !r.error || r.error === "conflict").length
  return { written, imageFailures }
}

/** 查一批 `_id` 在派生库里是否存在 */
async function fetchExistingIds(scope: DocumentScope<unknown>, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>()
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const keys = ids.slice(i, i + CHUNK)
    try {
      const res = await scope.fetch({ keys })
      for (const row of res.rows) {
        // 有 rev 说明文档真实存在（`_all_docs` 对不存在的 key 返回 {error: not_found}，没有 value）
        if ("value" in row && row.value?.rev) existing.add(row.id)
      }
    } catch {
      // 查询失败按「都不存在」处理：多写一次由 409 兜底，不会造成数据错误
    }
  }
  return existing
}

/** 按 `_id` 前缀范围删除（退订某个源时清掉它的全部条目） */
async function deleteByPrefix(scope: DocumentScope<unknown>, startkey: string, endkey: string): Promise<number> {
  let deleted = 0
  for (let page = 0; page < 200; page++) {
    const res = await scope.list({ startkey, endkey, limit: 500 })
    if (res.rows.length === 0) break
    const docs = res.rows.map(row => ({
      _id: row.id,
      _rev: (row.value as { rev: string }).rev,
      _deleted: true,
    }))
    const results = await scope.bulk({ docs })
    deleted += results.filter(r => !r.error).length
    if (res.rows.length < 500) break
  }
  return deleted
}

/** 删除单条文档（不存在则忽略） */
async function deleteDocIfExists(scope: DocumentScope<unknown>, id: string): Promise<void> {
  try {
    const doc = await scope.get(id) as { _rev: string }
    await scope.destroy(id, doc._rev)
  } catch {
    // 不存在 / 已被删：忽略
  }
}

/**
 * 拷贝源库的 FeedDoc（源名、站点、图标附件）到派生库。
 *
 * 必须单独 `get(..., {attachments: true})`：`_changes` 的 include_docs 不带附件，
 * 直接照抄会得到一个没有图标附件的 FeedDoc，侧边栏图标会在客户端变成原图直链。
 */
async function copyFeedDoc(
  scope: DocumentScope<unknown>,
  sourceScope: DocumentScope<unknown>,
  sourceId: string,
): Promise<void> {
  let source: Record<string, unknown>
  try {
    source = await sourceScope.get(sourceId, { attachments: true }) as unknown as Record<string, unknown>
  } catch {
    return // 源库还没有 FeedDoc（刚订阅、还没抓过），下次 reconcile 再来
  }
  let existingRev: string | undefined
  try {
    const existing = await scope.get(sourceId) as { _rev: string }
    existingRev = existing._rev
  } catch {
    // 还没有副本
  }
  const { _rev: _omitRev, _attachments, ...rest } = source
  const doc = { ...rest, _id: sourceId }
  if (_attachments && typeof _attachments === "object") {
    const attachments = Object.entries(_attachments as Record<string, { content_type?: string, data?: string }>)
      .filter(([, att]) => typeof att?.data === "string")
      .map(([name, att]) => ({
        name,
        data: Buffer.from(att.data as string, "base64"),
        content_type: att.content_type ?? "application/octet-stream",
      }))
    if (attachments.length > 0) {
      await scope.multipart.insert(doc as never, attachments as never, { docName: sourceId, ...(existingRev ? { rev: existingRev } : {}) } as never)
      return
    }
  }
  await scope.insert(existingRev ? { ...doc, _rev: existingRev } as never : doc as never)
}

// ── reconcile ──

export interface TimelineReconcileResult {
  userId: string
  /** 订阅源总数 */
  sources: number
  /** 本轮扫过的源（有新内容 / 新订阅 / 需要回填的） */
  scannedSources: number
  /** 写入派生库的新条目数 */
  addedEntries: number
  /** 因退订删除的条目数 */
  removedEntries: number
  /** 因窗口缩小剪枝掉的条目数 */
  prunedEntries: number
  /** 图片压缩失败张数（聚合一行日志） */
  imageFailures: number
  /** 逐源失败的源数与原因（不阻塞其余源） */
  failures: Array<{ sourceId: string, error: string }>
}

/** 回填时的分页大小（一页 100 条 × 最多 200 页 = 单源上限 2 万条） */
const BACKFILL_PAGE = 100
const BACKFILL_MAX_PAGES = 200
/** 增量 `_changes` 的分页大小 */
const CHANGES_PAGE = 200

/**
 * 一轮写入里**同时处理多少条目**（每条目内部的图片仍是串行的，见 writeEntries）。
 *
 * 为什么需要它：图片下载对「连不上的图床」要等满 10s 超时（见 images/fetch.ts），
 * 而一个源里往往整批图都来自同一个坏站点。逐条串行时，一个 200 条的源 = 200 × N × 10s，
 * 首次回填会卡成「几十分钟没有进展」的样子（实测 dev 里 627 个源就是这样）。
 * 并发 4 让超时重叠，同时把同时在飞的图片数限住（每条目自己仍按预算串行），
 * 避免把 CPU 打满（sharp 编码是 CPU 密集型，压几百张图会拖垮同进程的 API）。
 */
const ENTRY_WRITE_CONCURRENCY = 4

/**
 * 把一个用户的时间线派生库对齐到「当前订阅集合 + 当前设置」。
 *
 * 顺序是有意的：
 *   ① 退订清理 → ② 窗口剪枝 → ③ 逐源增量/回填 → ④ 写回状态
 * 先删后增保证「同一轮里先退订再加回同一个源」不会留下孤儿数据；状态最后写，
 * 中途失败时游标不会前移（宁可下一轮重扫一遍，也不漏条目）。
 *
 * 单个源失败只记进 failures：一个源的 CouchDB 抖动不该让剩下几百个源都不同步。
 */
export async function reconcileUserTimeline(
  userId: string,
  options: { backfill?: boolean } = {},
): Promise<TimelineReconcileResult> {
  const settings = await getTimelineSettings(userId)
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)
  const state = await readTimelineState(dbName)
  const sources = await listSubscriptionSources(userId)
  const subscribed = new Set(sources.map(s => s.id))

  const result: TimelineReconcileResult = {
    userId,
    sources: sources.length,
    scannedSources: 0,
    addedEntries: 0,
    removedEntries: 0,
    prunedEntries: 0,
    imageFailures: 0,
    failures: [],
  }

  // ① 退订清理：状态里有、订阅列表里没有的源
  for (const sourceId of Object.keys(state.sources)) {
    if (subscribed.has(sourceId)) continue
    const prefix = entryIdPrefix(sourceId)
    result.removedEntries += await deleteByPrefix(scope, prefix, `${prefix}\uffff`)
    await deleteDocIfExists(scope, sourceId)
    Reflect.deleteProperty(state.sources, sourceId)
  }

  // ② 窗口：缩小则剪枝（放大走③的回填）
  const windowStart = windowStartIso(settings.windowDays)
  const prevWindow = state.windowDays
  const windowExpanded = prevWindow !== null && settings.windowDays !== prevWindow
    && (settings.windowDays === 0 || settings.windowDays > prevWindow)
  const windowShrank = prevWindow !== null && settings.windowDays > 0
    && (prevWindow === 0 || prevWindow > settings.windowDays)
  if (windowShrank && windowStart) {
    result.prunedEntries += await pruneOlderThan(scope, windowStart)
  }

  // ③ 逐源聚合
  //
  // 每个源处理完就把状态落盘（而不是等整轮结束）。理由：一轮聚合在几百个源上可能跑十几分钟，
  // 「只在最后写一次」意味着跑不完就一步都没前进 —— 大账号会永远停在第一轮（下一轮又从头回填）。
  // 单个源的处理是原子的（条目全部写完才更新它的游标），所以中途落盘不会留下半截游标；
  // 而窗口字段（windowDays）仍只在最后写，窗口放大/缩小的判定保持全有或全无。
  let stateDirty = false
  for (const source of sources) {
    const sourceState = state.sources[source.id]
    const needBackfill = options.backfill === true || !sourceState || windowExpanded
    try {
      const sourceScope = await resolveSourceScope(source)
      if (!sourceState) await copyFeedDoc(scope, sourceScope, source.id)

      const outcome = needBackfill
        ? await backfillSource(scope, sourceScope, windowStart, settings)
        : await incrementalSource(scope, sourceScope, source.id, sourceState!.cursor, settings, windowStart)

      result.scannedSources += 1
      result.addedEntries += outcome.written
      result.imageFailures += outcome.imageFailures
      if (!sourceState) {
        // 新源：游标取回填前记录的 update_seq（工具返回），下次走增量
        state.sources[source.id] = { cursor: outcome.cursor, addedAt: new Date().toISOString() }
      } else if (!needBackfill) {
        // 回填（窗口放大 / 显式重建）时**不动游标**：回填扫的是视图，与 `_changes` 游标无关，
        // 用回填时的 update_seq 覆盖会把游标往回拨，下一轮重复扫一遍
        sourceState.cursor = outcome.cursor
      }
      stateDirty = true
    } catch (err) {
      result.failures.push({ sourceId: source.id, error: (err as Error)?.message ?? String(err) })
    }
    if (stateDirty) {
      stateDirty = false
      await writeTimelineState(dbName, state)
    }
  }

  // ④ 写回状态（含窗口字段：只有整轮跑完才认这一轮的窗口设置）
  state.windowDays = settings.windowDays
  state.settingsUpdatedAt = new Date().toISOString()
  await writeTimelineState(dbName, state)

  return result
}

/** 回填：按源库的 entries-by-date 视图取窗口内的条目（不依赖 _changes 游标） */
async function backfillSource(
  scope: DocumentScope<unknown>,
  sourceScope: DocumentScope<unknown>,
  windowStart: string | null,
  settings: TimelineSettings,
): Promise<{ written: number, imageFailures: number, cursor: string | number | null }> {
  // 游标取「扫描前」的 update_seq：扫描期间新写入的条目会由下一轮 _changes(since=seq) 补上，
  // 顺序反过来（先扫后取 seq）则会漏掉这中间写入的条目
  const before = await sourceScope.info()
  const cursor = (before as { update_seq?: string | number }).update_seq ?? null

  let written = 0
  let imageFailures = 0
  // 视图 key 是 publishedAt 字符串（ISO），按窗口下界做范围起点即可跳过窗口外的历史
  let startkey: string | undefined = windowStart ?? undefined
  let startkeyDocid: string | undefined
  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    const res = await sourceScope.view("main", "entries-by-date", {
      ...(startkey !== undefined ? { startkey } : {}),
      ...(startkeyDocid !== undefined ? { startkey_docid: startkeyDocid } : {}),
      // 第二页起跳过上一页的最后一行（startkey/startkey_docid 都是含端点的）
      ...(startkeyDocid !== undefined ? { skip: 1 } : {}),
      limit: BACKFILL_PAGE,
      include_docs: true,
      reduce: false,
    })
    if (res.rows.length === 0) break
    const docs = res.rows
      .map(row => row.doc as Record<string, unknown> | undefined)
      .filter((doc): doc is Record<string, unknown> => !!doc && doc.type === "entry" && inWindow(doc, windowStart))
    const outcome = await writeEntries(scope, docs, settings)
    written += outcome.written
    imageFailures += outcome.imageFailures
    if (res.rows.length < BACKFILL_PAGE) break
    const last = res.rows[res.rows.length - 1]!
    startkey = String(last.key)
    startkeyDocid = last.id
  }
  return { written, imageFailures, cursor }
}

/** 增量：从游标续跑源库的 `_changes`，只处理窗口内的条目 */
async function incrementalSource(
  scope: DocumentScope<unknown>,
  sourceScope: DocumentScope<unknown>,
  sourceId: string,
  cursor: string | number | null,
  settings: TimelineSettings,
  windowStart: string | null,
): Promise<{ written: number, imageFailures: number, cursor: string | number | null }> {
  let since = cursor ?? 0
  let written = 0
  let imageFailures = 0
  let lastSeq: string | number | null = since
  /** 游标失效（源库被重建过）时只允许回退重扫一次，避免死循环 */
  let resetDone = false

  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    let res: { results?: Array<{ id: string, seq: string | number, deleted?: boolean, doc?: Record<string, unknown> }>, last_seq: string | number }
    try {
      res = await sourceScope.changes({ since, include_docs: true, limit: CHANGES_PAGE }) as never
    } catch (err) {
      if (!resetDone) {
        // 源库被删除重建 / 清空过：旧 seq 不再有效，退回从头扫一遍（游标只在成功后前移）
        resetDone = true
        since = 0
        continue
      }
      throw err
    }
    const rows = res.results ?? []
    const feedDocTouched = rows.some(row => row.id === sourceId && !row.deleted)
    if (feedDocTouched) await copyFeedDoc(scope, sourceScope, sourceId)

    const docs = rows
      .filter(row => !row.deleted && row.doc && row.doc.type === "entry" && inWindow(row.doc, windowStart))
      .map(row => row.doc as Record<string, unknown>)
    const outcome = await writeEntries(scope, docs, settings)
    written += outcome.written
    imageFailures += outcome.imageFailures

    // 源库删掉的条目，派生库里也删掉（保持「派生库 = 源库窗口内的投影」）
    const deletedIds = rows
      .filter(row => row.deleted && row.id.startsWith("entry:"))
      .map(row => row.id)
    for (const id of deletedIds) await deleteDocIfExists(scope, id)

    lastSeq = res.last_seq
    since = res.last_seq
    if (rows.length < CHANGES_PAGE) break
  }
  return { written, imageFailures, cursor: lastSeq }
}

/** 剪枝：删掉发布时间早于窗口下界的条目 */
async function pruneOlderThan(scope: DocumentScope<unknown>, windowStart: string): Promise<number> {
  let pruned = 0
  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    const res = await scope.view("timeline-maintain", "by_published_at", {
      endkey: windowStart,
      inclusive_end: false,
      limit: 500,
      reduce: false,
    })
    if (res.rows.length === 0) break
    const ids = res.rows.map(row => row.id)
    pruned += await deleteDocsByIds(scope, ids)
    if (res.rows.length < 500) break
  }
  return pruned
}

/** 按 id 批量删除（先取 rev） */
async function deleteDocsByIds(scope: DocumentScope<unknown>, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await scope.fetch({ keys: ids })
  const docs: Array<{ _id: string, _rev: string, _deleted: true }> = []
  for (const row of res.rows) {
    if ("value" in row && row.value?.rev) docs.push({ _id: row.id, _rev: row.value.rev, _deleted: true })
  }
  if (docs.length === 0) return 0
  const results = await scope.bulk({ docs })
  return results.filter(r => !r.error).length
}

/**
 * 重建用户的派生库：删库 + 清库名 + 全量回填。
 *
 * 走「删库」而不是逐条重压：派生库里的内容全部可以从 feed/bot 库重算，
 * 图片压缩又有内容寻址缓存兜着（同参数不会重新压），所以重建是廉价且一定能收敛的动作。
 */
export async function rebuildUserTimeline(userId: string): Promise<TimelineReconcileResult> {
  const dbName = await ensureTimelineDatabase(userId)
  await nanoServer.db.destroy(dbName)
  // 库名置空：下次 ensure 会生成新库名并重装维护视图（库名是随机的，不复用已删库的名字）
  await db.update(user).set({ timelineDbName: null }).where(eq(user.id, userId))
  return await reconcileUserTimeline(userId, { backfill: true })
}

/** 所有用户 id（定时 reconcile 用；自建服务用户量小，一次全查没有问题） */
export async function listUserIds(): Promise<string[]> {
  const rows = await db.select({ id: user.id }).from(user)
  return rows.map(row => row.id)
}
