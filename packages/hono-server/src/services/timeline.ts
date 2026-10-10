import type { DocumentScope } from "nano"
import { eq } from "drizzle-orm"
import { db, user, userTimelineSettings, type NewUserTimelineSettings } from "../db"
import {
  createCouchDb,
  createTimelineDatabase,
  ensureBotDatabase,
  ensureFeedDatabase,
  ensureTimelineDatabase,
  nanoServer,
} from "../couchdb/client"
import {
  deleteReplications,
  ensureReplication,
  listUserReplications,
} from "../couchdb/replicator"

/**
 * 用户时间线聚合服务：维护「用户聚合库 = 他订阅的源在当前窗口内的子集」这份拓扑。
 *
 * **聚合库由 CouchDB 复制器搬出来**（见 couchdb/replicator.ts）：每个 (用户 × 订阅源) 一条
 * 常驻复制，JS filter 按窗口过滤。所以这一层只管四件事：
 *   ① 拓扑：订阅了谁就该有谁的任务；退订、换窗口就把过期任务删掉（换窗口 = 换复制哈希 = 重扫回填）；
 *   ② 剪枝：复制器不会因为过滤变严而删目标端已有的文档，窗口的权威在 pruneOlderThan；
 *   ③ 重建：聚合库是从源库"修剪"出来的，修剪坏了/要按新窗口整体重来时就换一个空库重搬
 *      （见 rederiveUserTimeline —— 复制是变更投递，就地清空是搬不回来的）；
 *   ④ 状态：`_local/state` 只留版本标记与设置快照（任务清单本身就是"哪些源在搬"的真相）。
 *
 * 稳态下一轮的成本是「一次订阅列表读 + 一次 `_replicator` 列 + 一次剪枝视图查询」，一个写
 * 请求都不发；新订阅 / 窗口变化才建删任务，由复制器自己去扫源库。客户端侧与订阅数无关。
 *
 * **客户端不做二次修剪**：浏览器把聚合库整份同步下来（条目只读、状态可写），窗口的裁剪只发生
 * 在服务端 —— 服务端剪掉的条目会作为删除事件复制过去，本地跟着删，前端不需要再判一遍窗口。
 *
 * **附件不由这里产生**：正文图在抓取时按 **per-feed 策略**下载压缩成 AVIF 附件写进源库
 * （见 rss/entry-images.ts 与 workers/index.ts）。复制器在 CouchDB 内部以 multipart 搬运它们
 * ——二进制、不经过我们的进程、不吃内存、不做 base64 往返，所以同一张图在所有用户库里字节一致。
 *
 * 触发方：定时任务（workers/timeline.ts，默认 5 分钟）+ 客户端主动刷新
 * （POST /api/timeline/refresh，订阅/退订后调用）。
 */

// ── 每用户设置 ──

/** 时间线聚合设置（用户可调） */
export interface TimelineSettings {
  /** 回填窗口天数；0 = 不限时间 */
  windowDays: number
  /** 是否生成 AI 摘要（本轮只落存储位与文档字段，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 缺省值 */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  windowDays: 3,
  aiSummaryEnabled: false,
}

/** 各设置项的合法区间（路由/服务共用，避免两处各写一份校验） */
export const TIMELINE_SETTING_LIMITS = {
  windowDays: { min: 0, max: 365 },
} as const

/** PG 行（或缺失）→ 有效设置：null 一律回退全局默认 */
export function normalizeTimelineSettings(row: Partial<Record<keyof TimelineSettings, unknown>> | null | undefined): TimelineSettings {
  const pick = (key: keyof TimelineSettings, fallback: number): number => {
    const raw = row?.[key]
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback
  }
  return {
    windowDays: pick("windowDays", DEFAULT_TIMELINE_SETTINGS.windowDays),
    aiSummaryEnabled: row?.aiSummaryEnabled === true,
  }
}

/**
 * 校验客户端提交的设置补丁（纯函数，供路由与单测复用）。
 *
 * 越界/类型错误一律报错而不是静默夹取：窗口直接决定服务端要扫多长的历史（以及用户库里
 * 存多少条），「以为设成 7 天结果被当成 365 天」这种静默纠正在排查时毫无信号。
 */
export function parseTimelineSettingsPatch(raw: unknown): { patch: Partial<TimelineSettings>, errors: string[] } {
  const errors: string[] = []
  const patch: Partial<TimelineSettings> = {}
  if (raw === null || typeof raw !== "object") {
    return { patch, errors: ["请求体必须是对象"] }
  }
  const input = raw as Record<string, unknown>
  const intKeys: Array<keyof typeof TIMELINE_SETTING_LIMITS> = ["windowDays"]
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

/** 读取用户的时间线设置（没有行 = 全部全局默认） */
export async function getTimelineSettings(userId: string): Promise<TimelineSettings> {
  const [row] = await db.select().from(userTimelineSettings)
    .where(eq(userTimelineSettings.userId, userId)).limit(1)
  return normalizeTimelineSettings(row ?? null)
}

/**
 * 写入用户的时间线设置（UPSERT），返回生效后的设置。
 *
 * 不需要重建：窗口是「回填/剪枝」的边界，由 reconcile 自己处理（缩小剪枝、放大回填），
 * 条目内容与附件只由源库决定，不随用户设置变化（见文件头）。
 */
export async function updateTimelineSettings(
  userId: string,
  patch: Partial<TimelineSettings>,
): Promise<{ settings: TimelineSettings }> {
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
  return { settings: await getTimelineSettings(userId) }
}

// ── 窗口 ──

/** 窗口下界（ISO）；windowDays <= 0 返回 null = 不限时间 */
export function windowStartIso(windowDays: number, now: number = Date.now()): string | null {
  if (windowDays <= 0) return null
  return new Date(now - windowDays * 86_400_000).toISOString()
}

// ── 源 ──

export interface TimelineSource {
  /** 源 id：feedId 或 `bot:{botId}` */
  id: string
  kind: "feed" | "bot"
}

/** 读取用户的订阅源集合（只读用户库的 subscription 文档，不查 PG 注册表） */
export async function listSubscriptionSources(userId: string): Promise<TimelineSource[]> {
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
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

/** 源 id → 源库**名**（bot 订阅读 bot 产出库；复制文档里直接写库名，不需要 DocumentScope） */
async function resolveSourceDbName(source: TimelineSource): Promise<string> {
  if (source.kind === "bot") return await ensureBotDatabase(source.id.slice("bot:".length))
  return await ensureFeedDatabase(source.id)
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
// 「服务端做到哪了」这种纯内部状态；同时它随聚合库一起删除，重建即重来。
//
// 内容只剩「版本标记 + 设置快照」：每源游标已经没有用了 —— 增量由复制器自己按 checkpoint
// 续跑，而"哪些源已经在搬"的真相是 `_replicator` 里属于这个用户的文档（见 listUserReplications）。

const STATE_DOC_ID = "_local/state"

/**
 * 状态版本 2：搬运从「自己读 `_changes`、按窗口写文档」换成「CouchDB 复制器搬运」。
 *
 * 版本 1 的聚合库里，文档是用**我们自己的修订**写进去的；复制器按源库修订谱系落库
 * （`new_edits: false`），同一个 `_id` 上会出现两条互不相干的修订 → 冲突。而"就地清空再重搬"
 * 做不到（目标端删过的 rev 复制器不会再送），所以 v1 → v2 的升级走的是**换库重搬**：
 * 另建一个空聚合库、把用户自己写的状态文档搬过去，让复制器从头搬一遍。
 */
const STATE_VERSION = 2

interface TimelineState {
  version: number
  /** 上次 reconcile 生效的窗口天数（诊断用） */
  windowDays: number | null
  settingsUpdatedAt: string | null
}

function emptyState(): TimelineState {
  return { version: STATE_VERSION, windowDays: null, settingsUpdatedAt: null }
}

/** 读状态文档；不存在（首次/新库）返回空状态 */
async function readTimelineState(dbName: string): Promise<TimelineState> {
  try {
    const doc = await nanoServer.request({ db: dbName, doc: STATE_DOC_ID, method: "GET" }) as Partial<TimelineState>
    // 只有**明确写着 version 1** 的老库才算需要换库重搬。老实现是显式写 `version: 1` 的（核对过
    // 线上库），所以"没有 version 字段"只可能是取不到文档（nano 在 404 时也可能回一个 error 体），
    // 这时必须当成当前版本 —— 否则每个新账号的第一次 reconcile 都会白换一次库。
    if (typeof doc?.version !== "number") return emptyState()
    return {
      version: doc.version,
      windowDays: typeof doc.windowDays === "number" ? doc.windowDays : null,
      settingsUpdatedAt: typeof doc.settingsUpdatedAt === "string" ? doc.settingsUpdatedAt : null,
    }
  } catch {
    return emptyState()
  }
}

/** 写状态文档（`_local` 文档必须走 PUT /db/_local/state，不能用 insert） */
async function writeTimelineState(dbName: string, state: TimelineState): Promise<void> {
  // 冲突（同用户的两次 reconcile 撞车）就地重读一次 rev 再写：状态文档丢了不影响正确性
  // （下一轮最多多做一次幂等的换库重搬），但会让日志噪声大，值得重试一次
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

async function deleteByPrefix(scope: DocumentScope<unknown>, startkey: string, endkey: string): Promise<number> {
  let deleted = 0
  for (let page = 0; page < MAX_PAGE_LOOPS; page++) {
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

/**
 * 删除单条文档（不存在则忽略），返回是否真的删掉了。
 *
 * 带 3 次重试：退订是「先删复制任务、再删目标端文档」，而任务被删掉的那一刻复制器可能
 * 正好还在写这个文档（`_rev` 变了 → 409）。不重试的话这份 FeedDoc 副本会永久留在用户库里
 * —— 下一轮 reconcile 已经没有这个源了，不会再来删它。
 */
async function deleteDocIfExists(scope: DocumentScope<unknown>, id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const doc = await scope.get(id) as { _rev: string }
      await scope.destroy(id, doc._rev)
      return true
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return false
      // 409 = 复制器刚写过，重读 rev 再试
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  return false
}

/** 分页循环上限（删除/剪枝都是"删到空为止"，这是兜底防死循环） */
const MAX_PAGE_LOOPS = 200

/** 剪枝：删掉发布时间早于窗口下界的条目（复制器不会因为 selector 变严而删目标端已有文档） */
async function pruneOlderThan(scope: DocumentScope<unknown>, windowStart: string): Promise<number> {
  let pruned = 0
  for (let page = 0; page < MAX_PAGE_LOOPS; page++) {
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

// ── 同一用户串行化 ──
//
// API 与 worker 同进程（见 docker-deployment 的「单副本」），但同一个用户完全可能有两轮聚合同时在跑：
// 客户端催一次（`POST /api/timeline/refresh`）时，队列里那个定时任务可能正好也在处理同一个用户。
// 两轮并发没有共享状态上的正确性问题（写都是幂等的），但**重建 / v1→v2 升级**这类"整体换库"的动作不行：
// 两边都会读到 `version: 1`、各自换一个空库出来，最后只有一份名字生效，另一个库就成了没人指得着、
// 也不会有复制任务的孤儿（表现为"重建后内容一直不回来"）。所以这里按用户串行，跨用户仍然并行。

/** userId → 该用户当前那条任务链的尾巴 */
const userTimelineLocks = new Map<string, Promise<void>>()

/** 把一个动作排到该用户任务链的末尾（前一个失败也继续排，失败由各自的调用方处理） */
async function withUserLock<T>(userId: string, action: () => Promise<T>): Promise<T> {
  const previous = userTimelineLocks.get(userId) ?? Promise.resolve()
  const run = previous.then(action, action)
  const tail = run.then(() => {}, () => {})
  userTimelineLocks.set(userId, tail)
  try {
    return await run
  } finally {
    // 只有自己还是链尾时才清掉，否则会把后来者的链尾一起删了
    if (userTimelineLocks.get(userId) === tail) userTimelineLocks.delete(userId)
  }
}

export interface TimelineReconcileResult {
  userId: string
  /** 订阅源总数 */
  sources: number
  /** 本轮新建的复制任务数（新订阅、窗口变化、重建 / 换库重搬） */
  createdReplications: number
  /** 本轮删掉的复制任务数（退订、窗口变化、重建 / 换库重搬） */
  removedReplications: number
  /** 因退订删除的条目数 */
  removedEntries: number
  /** 因窗口剪枝删除的条目数 */
  prunedEntries: number
  /** 逐源失败的原因（不阻塞其余源） */
  failures: Array<{ sourceId: string, error: string }>
}

/**
 * 把一个用户的聚合库对齐到「当前订阅集合 + 当前设置」。
 *
 * 顺序是有意的：① 换库重搬（仅 v1 → v2 升级）→ ② 退订/换窗口清理 → ③ 剪枝 → ④ 补建任务
 * → ⑤ 写状态。先删后建保证「同一轮里先退订再加回同一个源」不会留下孤儿数据；任务补建在剪枝
 * 之后，新任务的 query_params 就是当前窗口（= 新的复制哈希），复制器会从 0 扫一遍源库。
 *
 * 单个源失败只记进 failures：一个源的库抖动不该让剩下几百个源都不同步。
 */
export async function reconcileUserTimeline(
  userId: string,
  options: { backfill?: boolean } = {},
): Promise<TimelineReconcileResult> {
  return await withUserLock(userId, () => reconcileUserTimelineUnlocked(userId, options))
}

/** reconcile 本体（调用方必须已经持有该用户的锁） */
async function reconcileUserTimelineUnlocked(
  userId: string,
  options: { backfill?: boolean } = {},
): Promise<TimelineReconcileResult> {
  const settings = await getTimelineSettings(userId)
  let dbName = await ensureTimelineDatabase(userId)
  let scope = createCouchDb(dbName)
  let state = await readTimelineState(dbName)

  // ① v1 → v2 一次性升级：老库里服务端独占文档带的是我们自己的修订，留着会和复制器搬来的
  //    修订谱系冲突；而"就地清空再重搬"做不到（目标端删过的 rev 复制器不会再送）。所以换成
  //    一个空库重搬（用户自己写的状态文档跟着搬过去），后面的 ④ 会按当前窗口重建任务。
  if (state.version < STATE_VERSION) {
    dbName = await rederiveUserTimeline(userId, dbName)
    scope = createCouchDb(dbName)
    state = await readTimelineState(dbName)
  }

  const sources = await listSubscriptionSources(userId)
  const subscribed = new Set(sources.map(source => source.id))

  const result: TimelineReconcileResult = {
    userId,
    sources: sources.length,
    createdReplications: 0,
    removedReplications: 0,
    removedEntries: 0,
    prunedEntries: 0,
    failures: [],
  }

  // ② 清理：退订的源，以及窗口天数已经变了的源（id 里带着 windowDays）。
  //    「换窗口」只删任务不删数据：缩小由 ③ 剪枝兜底，放大由 ④ 的新任务重扫回填
  //    （query_params 变了 = 换了复制哈希 = 从 0 扫源库）。
  let existing = await listUserReplications(userId)
  const stale = existing.filter(item =>
    !subscribed.has(item.sourceId) || item.windowDays !== settings.windowDays)
  if (stale.length > 0) {
    await deleteReplications(stale.map(item => ({ docId: item.docId, rev: item.rev })))
    result.removedReplications += stale.length
    const staleIds = new Set(stale.map(item => item.docId))
    existing = existing.filter(item => !staleIds.has(item.docId))
    for (const item of stale) {
      if (subscribed.has(item.sourceId)) continue // 只是窗口变了：数据留着，别删
      const prefix = entryIdPrefix(item.sourceId)
      result.removedEntries += await deleteByPrefix(scope, prefix, `${prefix}\uffff`)
      await deleteDocIfExists(scope, item.sourceId)
    }
  }

  // ③ 剪枝：窗口的权威在这里。复制器的过滤下界是创建时固定的（见 replicator.ts），
  //    会越来越松，所以只要有窗口就每轮都剪一遍（视图查询，没东西可删时是空结果）。
  const windowStart = windowStartIso(settings.windowDays)
  if (windowStart) result.prunedEntries += await pruneOlderThan(scope, windowStart)

  // ④ 补建任务：复制器接手初始回填（从 0 扫源库）与后续增量。
  //    走到这里说明该源没有"当前窗口"的任务，也就是复制哈希是新的
  const current = new Map(existing.map(item => [item.sourceId, item]))
  for (const source of sources) {
    if (current.has(source.id)) continue
    try {
      const sourceDb = await resolveSourceDbName(source)
      const outcome = await ensureReplication({
        userId,
        windowDays: settings.windowDays,
        sourceId: source.id,
        sourceDb,
        targetDb: dbName,
      })
      if (outcome === "created") result.createdReplications += 1
    } catch (err) {
      result.failures.push({ sourceId: source.id, error: (err as Error)?.message ?? String(err) })
    }
  }

  // ⑤ 写回状态（含窗口字段）
  state.version = STATE_VERSION
  state.windowDays = settings.windowDays
  state.settingsUpdatedAt = new Date().toISOString()
  await writeTimelineState(dbName, state)

  return result
}

/** 换库重搬时每批搬运的文档数（`_all_docs` 一页 + `_bulk_docs` 一次） */
const INTENT_COPY_BATCH = 500
/** 换库重搬时最多搬多少页（每页 500，够一个用户的订阅 + 已读收藏量级） */
const INTENT_COPY_MAX_PAGES = 400

/**
 * 换一个空聚合库并接管该用户，把**用户自己写的文档**搬过去（重建与 v1→v2 升级共用）。
 *
 * 搬的是"非服务端独占"的文档：`entry:*` 是聚合产物（复制器会重搬一遍），裸 id 的 FeedDoc
 * 副本同理；其余（`subscription:*` 订阅、`entry-state:*` 已读收藏、`group-pref:*` 列表偏好，
 * 以及将来客户端加的任何状态文档）都是用户意图，必须跟着走。
 *
 * 为什么换库而不是就地清空：聚合库是复制器的目标端，而复制是**变更投递不是投影** ——
 * 目标端自己删过的 rev，复制器不会再送回来（实测）；换一个空库则连 checkpoint（在库的
 * `_local` 里）一起消失，新任务会从 0 扫源库、把窗口内的内容完整重搬一遍。
 *
 * 返回新库名。
 */
async function rederiveUserTimeline(userId: string, oldDbName: string): Promise<string> {
  const oldScope = createCouchDb(oldDbName)
  const sourceIds = new Set((await listSubscriptionSources(userId)).map(source => source.id))

  // 先换库（顺带把 user.timeline_db_name 指向新库），再搬意图文档，最后删旧库
  const newDbName = await createTimelineDatabase(userId)
  const newScope = createCouchDb(newDbName)
  let copied = 0
  let startkey: string | undefined
  for (let page = 0; page < INTENT_COPY_MAX_PAGES; page++) {
    const listed = await oldScope.list({
      limit: INTENT_COPY_BATCH,
      include_docs: true,
      ...(startkey ? { startkey, skip: 1 } : {}),
    }) as never as { rows: Array<{ id: string, doc?: Record<string, unknown> }> }
    const rows = listed.rows ?? []
    if (rows.length === 0) break
    const docs = rows
      .filter(row => row.doc && keepOnRebuild(row.id, sourceIds))
      .map(row => {
        const { _rev: _ignoredRev, _revisions: _ignoredRevs, ...rest } = row.doc as Record<string, unknown>
        return rest
      })
    if (docs.length > 0) {
      await newScope.bulk({ docs } as never)
      copied += docs.length
    }
    if (rows.length < INTENT_COPY_BATCH) break
    startkey = rows[rows.length - 1]!.id
  }

  // 并发重建（定时 reconcile 撞上手动重建）时只留一个赢家：库名最后写进去的那个生效，
  // 输的那个把自己刚建的空库删掉、改用赢家的库 —— 否则会多一个装着一份订阅副本的孤儿库，
  // 而它上面永远不会有复制任务（内容再也不会更新）。
  const winner = await ensureTimelineDatabase(userId)
  if (winner !== newDbName) {
    try {
      await nanoServer.db.destroy(newDbName)
    } catch {
      // 已删 / 正被删：忽略
    }
    console.warn(`[Timeline] 用户=${userId} 并发重建：丢弃 ${newDbName}，改用 ${winner}`)
    return winner
  }

  // 旧库上的复制任务全部作废：目标库换了，任务必须按新库重建
  const jobs = await listUserReplications(userId)
  await deleteReplications(jobs.map(item => ({ docId: item.docId, rev: item.rev })))

  // 旧库已经没用了（新库接管 + 任务已删），删掉省空间；删失败不影响正确性
  try {
    await nanoServer.db.destroy(oldDbName)
  } catch {
    // 旧库已被删/正被删：忽略
  }

  console.log(`[Timeline] 用户=${userId} 换库重搬：${oldDbName} → ${newDbName}（搬走用户状态 ${copied} 条，作废复制任务 ${jobs.length} 条）`)
  return newDbName
}

/**
 * 换库重搬时是否保留这个文档：服务端独占的聚合产物不搬（复制器会重搬一遍），其余都搬。
 *
 * 判据与服务端写方向闸门一致（见 client.ts 的 TIMELINE_VALIDATE_DOC_UPDATE）：客户端只能写
 * 非 `entry`/`feed` 文档，所以"不是 `entry:*` 前缀、也不是订阅源的裸 FeedDoc id"就是用户自己的东西。
 */
function keepOnRebuild(id: string, sourceIds: Set<string>): boolean {
  if (id.startsWith("_design/")) return false
  if (id.startsWith("entry:")) return false // '-' < ':'，所以不会误伤 entry-state:*
  if (sourceIds.has(id)) return false
  return true
}

/**
 * 等派生库安静下来（「手动同步」的 `wait=1`）。
 *
 * 复制是异步的，没有「现在同步一次」的触发接口，所以等待的判据是**派生库自己的 `_changes`**：
 * 从开始时的 `update_seq` 往后读增量，连续若干轮没有新条目就认为追平了。
 *
 * 两个必须的保守设置（都是从真库里量出来的）：
 *   - `minWaitMs`（默认 4s）：任务刚建好时复制器还没开始写，此时派生库就是"安静的"。
 *     不设最短等待就会立刻返回 added=0，而内容其实还在路上（实测首轮搬运 0.5~2.8s）。
 *   - `quietRounds`（默认 5 轮 × 400ms = 2s）：单轮空读可能只是复制器在批量落盘的间隙。
 *
 * 为什么不用复制器的状态（`_scheduler/docs` 的 `checkpointed_source_seq` / `changes_pending`）：
 * 实测这两个字段在首次扫描期间是 undefined，checkpoint 又要到批末才落盘 —— 都滞后于文档真正到端，
 * 用它们会把"已到端"误判成"还没追上"。
 *
 * 返回这期间**新到的条目数**与是否在超时前追平；超时不算失败（复制仍在后台跑）。
 */
export async function waitForSync(
  userId: string,
  timeoutMs: number,
  options: { quietRounds?: number, pollIntervalMs?: number, minWaitMs?: number } = {},
): Promise<{ completed: boolean, added: number }> {
  const quietRounds = options.quietRounds ?? 5
  const pollIntervalMs = options.pollIntervalMs ?? 400
  const minWaitMs = options.minWaitMs ?? 4000
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)

  let since: string | number = (await scope.info() as { update_seq?: string | number }).update_seq ?? 0
  let added = 0
  let quiet = 0
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    let rows: Array<{ id: string, seq: string | number, deleted?: boolean }> = []
    let lastSeq: string | number = since
    try {
      const res = await scope.changes({ since, include_docs: false, limit: 500 }) as never as {
        results?: Array<{ id: string, seq: string | number, deleted?: boolean }>
        last_seq: string | number
      }
      rows = res.results ?? []
      lastSeq = res.last_seq
    } catch {
      // 读 `_changes` 失败（库正忙/重启）：按"这一轮没有新东西"处理，由超时兜底
      continue
    }
    // `entry-state:` 等客户端状态文档也在这条流里，只数条目
    const entries = rows.filter(row => !row.deleted && row.id.startsWith("entry:")).length
    added += entries
    since = lastSeq
    if (rows.length === 0) {
      quiet += 1
      // 「安静」+ 「已经等够最短时间」才敢说追平了（否则任务可能还没开始搬）
      if (quiet >= quietRounds && Date.now() - startedAt >= minWaitMs) return { completed: true, added }
    } else {
      quiet = 0
    }
  }
  return { completed: false, added }
}

/**
 * 重建聚合库：换一个空库重新"修剪"一遍（重新从全量源库按当前窗口搬），用户状态跟着走。
 *
 * 为什么必须是换库：聚合库是复制器的目标端，而复制是**变更投递不是投影** —— 目标端自己删过的
 * rev 复制器不会再送（实测），所以"就地删文档 + 删任务"搬不回来；换库则连 checkpoint
 * （存在库的 `_local` 里）一起清掉，新任务从 0 扫源库。
 *
 * 用户自己写的文档（订阅、已读收藏、分组偏好）由 rederiveUserTimeline 搬到新库，
 * 所以重建不会丢订阅关系（丢了就等于"重建一次，订阅全没了"）。
 *
 * 触发入口：设置页的「重建时间线」与 `POST /api/timeline/rebuild`。
 */
export async function rebuildUserTimeline(userId: string): Promise<TimelineReconcileResult> {
  return await withUserLock(userId, () => rebuildUserTimelineUnlocked(userId))
}

/** 重建本体（调用方必须已经持有该用户的锁） */
async function rebuildUserTimelineUnlocked(userId: string): Promise<TimelineReconcileResult> {
  const oldDbName = await ensureTimelineDatabase(userId)
  const existing = await listUserReplications(userId)
  await rederiveUserTimeline(userId, oldDbName)
  const result = await reconcileUserTimelineUnlocked(userId, { backfill: true })
  return {
    ...result,
    removedReplications: result.removedReplications + existing.length,
  }
}

/** 所有用户 id（定时 reconcile 用；自建服务用户量小，一次全查没有问题） */
export async function listUserIds(): Promise<string[]> {
  const rows = await db.select({ id: user.id }).from(user)
  return rows.map(row => row.id)
}
