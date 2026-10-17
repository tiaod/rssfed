import { createHash } from "node:crypto"
import type { DocumentScope } from "nano"
import { and, eq, inArray } from "drizzle-orm"
import {
  bots as botsTable,
  db,
  feeds,
  timelineSourceSync,
  user,
  userTimelineSettings,
  type NewUserTimelineSettings,
} from "../db"
import { recordTimelineEvent } from "./timeline-events"
import {
  createCouchDb,
  createTimelineDatabase,
  ensureBotDatabase,
  ensureFeedDatabase,
  ensureTimelineDatabase,
  nanoServer,
} from "../couchdb/client"
import {
  purgeLegacyReplications,
  runSourceReplication,
} from "../couchdb/replicator"

/**
 * 用户时间线聚合服务：维护「用户聚合库 = 他订阅的源当前内容的**精确镜像**」这份拓扑。
 *
 * **保留策略只有一个权威、且只按源生效**：每条源库裁到最新 N 条（`couchdb/retention.ts`，
 * 抓取 worker 写完新条目后裁一次）。用户库和浏览器都只是镜像 —— 源库删了哪条，删除就作为
 * `_deleted` 变更随复制传到用户库、再随 live 拉取传到 PouchDB。所以这里**不剪枝、不算窗口、
 * 没有按用户生效的保留参数**（见 `docs/notes/aggregation/source-side-retention-plan.md`）。
 *
 * **搬运仍由 CouchDB 复制器完成，但改由我们按需触发**（见 couchdb/replicator.ts）：
 *   ① 水位：每个 (用户 × 源) 在 PG 里记一行 `timeline_source_sync`（上次同步时刻）。
 *      reconcile 只把「上次同步之后源那边有过变化」的源（feed 看 `feeds.lastChangedAt`，它把
 *      "只裁剪删除"也算进来；bot 看 `lastNewEntryAt`）与新订阅的源交给 `rss-timeline-sync` 队列
 *      （限并发跑一次性复制）。**没变化的源一个复制请求都不发** —— 这正是把常驻复制换掉的意义：
 *      实测单源复制即使无内容可搬也要 ~1.3s（建复制会话的固定开销），625 个源每轮空转就是
 *      十几分钟机器时间。
 *   ② 复制不带任何参数：过滤器源码稳定 → checkpoint 哈希稳定 → 每次只搬增量。代价是"改了
 *      保留策略"不会自动回填，需要重建聚合库（见 rederiveUserTimeline）。
 *   ③ 重建：聚合库是从源库复制出来的，要整体重来时就换一个空库重搬（复制是变更投递，
 *      就地清空是搬不回来的）；
 *   ④ 清理：退订的源按前缀删条目 + 删水位行；升级后把遗留的**常驻**复制任务一次性清掉。
 *
 * 稳态下一轮的成本是「一次订阅列表读 + 一条水位 SQL」，**脏源为空时一个写请求都不发**，
 * 客户端侧与订阅数无关。
 *
 * **附件不由这里产生**：正文图在抓取时按 **per-feed 策略**下载压缩成 AVIF 附件写进源库
 * （见 rss/entry-images.ts 与 workers/index.ts）。复制器在 CouchDB 内部以 multipart 搬运它们
 * ——二进制、不经过我们的进程、不吃内存、不做 base64 往返，所以同一张图在所有用户库里字节一致。
 *
 * 触发方：定时任务（workers/timeline.ts，默认 5 分钟）+ 客户端主动刷新
 * （POST /api/timeline/refresh，订阅/退订后调用）。
 */

// ── 每用户设置 ──

/** 用户可调的聚合设置。**保留策略不在这里** —— 它是源库裁剪（每源最新 50 条），全局一个值。 */
export interface TimelineSettings {
  /** 是否生成 AI 摘要（本轮只落存储位与文档字段，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 缺省值 */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  aiSummaryEnabled: false,
}

/** PG 行（或缺失）→ 有效设置 */
export function normalizeTimelineSettings(row: Partial<Record<keyof TimelineSettings, unknown>> | null | undefined): TimelineSettings {
  return { aiSummaryEnabled: row?.aiSummaryEnabled === true }
}

/** 校验客户端提交的设置补丁（纯函数，供路由与单测复用） */
export function parseTimelineSettingsPatch(raw: unknown): { patch: Partial<TimelineSettings>, errors: string[] } {
  if (raw === null || typeof raw !== "object") return { patch: {}, errors: ["请求体必须是对象"] }
  const input = raw as Record<string, unknown>
  if (!("aiSummaryEnabled" in input)) return { patch: {}, errors: [] }
  if (typeof input.aiSummaryEnabled !== "boolean") return { patch: {}, errors: ["aiSummaryEnabled 需为布尔值"] }
  return { patch: { aiSummaryEnabled: input.aiSummaryEnabled }, errors: [] }
}

export async function getTimelineSettings(userId: string): Promise<TimelineSettings> {
  const [row] = await db.select().from(userTimelineSettings)
    .where(eq(userTimelineSettings.userId, userId)).limit(1)
  return normalizeTimelineSettings(row ?? null)
}

/**
 * 写入用户的时间线设置（UPSERT），返回生效后的设置。
 *
 * 不需要重建：剩下的设置（AI 摘要开关）只是标记位，条目内容与保留策略只由源库裁剪决定，
 * 不随用户设置变化（见文件头）。
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
// 内容只剩「版本标记 + 设置快照 + 升级清理标记」：每源进度不在这里 —— 增量由复制器的
// checkpoint 续跑，而"上次同步到哪"是 PG 里的 `timeline_source_sync`（见上面的水位线一节）。

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
  /** 是否已经清理过历史遗留的**常驻**复制任务（升级一次性动作，见 ④） */
  replicatorsPurged?: boolean
}

function emptyState(): TimelineState {
  return { version: STATE_VERSION, replicatorsPurged: false }
}

/** 读状态文档；不存在（首次/新库）返回空状态 */
async function readTimelineState(dbName: string): Promise<TimelineState> {
  try {
    const doc = await nanoServer.request({ db: dbName, doc: STATE_DOC_ID, method: "GET" }) as Partial<TimelineState>
    // 只有**明确写着 version 1** 的老库才算需要换库重搬。老实现是显式写 `version: 1` 的（核对过
    // 线上库），所以"没有 version 字段"只可能是取不到文档（nano 在 404 时也可能回一个 error 体），
    // 这时必须当成当前版本 —— 否则每个新账号的第一次 reconcile 都会白换一次库。
    if (typeof doc?.version !== "number") return emptyState()
    return { version: doc.version, replicatorsPurged: doc.replicatorsPurged === true }
  } catch {
    return emptyState()
  }
}

/**
 * 派生库是不是「空的/刚换过的」—— 判据是状态文档不存在（404）。
 *
 * 为什么需要：水位行只在「这个库确实已经有内容」时才有意义。库没了/换库了（重建、手工删库），
 * 内容全空，此时若还信水位，那些"源那边没有新内容"的源就永远不会被搬 → 重建之后聚合库一直是空的。
 * 所以每次 reconcile 先问一句"这个库还是原来那个吗"，不是就把该用户的水位整份清掉、全量重搬。
 *
 * 读失败（非 404：CouchDB 抖动）**不**当成新库 —— 那种情况下清水位会引发一次全量重扫，
 * 宁可这轮什么都不做，等下一轮。
 */
async function isDerivedDbFresh(dbName: string): Promise<boolean> {
  try {
    const doc = await nanoServer.request({ db: dbName, doc: STATE_DOC_ID, method: "GET" }) as { version?: unknown }
    // 文档在但版本号不对（v1 老库）：reconcile 会走换库重搬，等价于"新库"
    return typeof doc?.version !== "number"
  } catch (err) {
    return (err as { statusCode?: number })?.statusCode === 404
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

/** 分页循环上限（删除都是"删到空为止"，这是兜底防死循环） */
const MAX_PAGE_LOOPS = 200

/** 同一用户的聚合串行化：重建/升级/退订清理不能并发跑（并发会各建一个新库） */
const userTimelineLocks = new Map<string, Promise<unknown>>()

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

// ── 同步水位（决定"这个源这次要不要搬"） ──
//
// 客户端聚合时代，增量判断在浏览器里：localStorage 记每个源的上次同步时间，再拿服务端
// `feeds.lastNewEntryAt` 逐个比。现在聚合在服务端，这份判断整体搬到服务端 —— 水位落在 PG 的
// `timeline_source_sync`（每 (用户 × 源) 一行），信号源仍是 `feeds/bots.lastNewEntryAt`。
//
// 为什么水位不放用户库的 `subscription:` 文档上：那是客户端也会写的文档（PouchDB 双向同步），
// 服务端往上写会和用户的订阅编辑撞修订冲突。放 PG 还顺带能按 source_id 反查订阅者。

/** 一行同步水位 */
export interface SourceSyncWatermark {
  /** 上次同步**开始**的时刻（不是完成时刻，见 db/schema.ts 里的说明） */
  syncedAt: Date | null
  status: string
  sourceSeq: string | null
  lastError: string | null
}

/** 读该用户所有水位行 */
async function readSourceWatermarks(userId: string): Promise<Map<string, SourceSyncWatermark>> {
  const rows = await db.select({
    sourceId: timelineSourceSync.sourceId,
    syncedAt: timelineSourceSync.syncedAt,
    status: timelineSourceSync.status,
    sourceSeq: timelineSourceSync.sourceSeq,
    lastError: timelineSourceSync.lastError,
  }).from(timelineSourceSync).where(eq(timelineSourceSync.userId, userId))
  return new Map(rows.map(row => [row.sourceId, {
    syncedAt: row.syncedAt,
    status: row.status,
    sourceSeq: row.sourceSeq,
    lastError: row.lastError,
  }]))
}

/** 读单个源的水位行（单源同步任务用：整份读在 600 个源时会退化成 O(n²) 行传输） */
async function readSourceWatermark(userId: string, sourceId: string): Promise<SourceSyncWatermark | undefined> {
  const [row] = await db.select({
    syncedAt: timelineSourceSync.syncedAt,
    status: timelineSourceSync.status,
    sourceSeq: timelineSourceSync.sourceSeq,
    lastError: timelineSourceSync.lastError,
  }).from(timelineSourceSync).where(and(
    eq(timelineSourceSync.userId, userId),
    eq(timelineSourceSync.sourceId, sourceId),
  )).limit(1)
  return row
}

/** 该用户的派生库整个换掉/丢了：水位一律作废，所有源重新搬（见 isDerivedDbFresh） */
async function clearSourceWatermarks(userId: string): Promise<void> {
  await db.delete(timelineSourceSync).where(eq(timelineSourceSync.userId, userId))
}

async function deleteSourceWatermark(userId: string, sourceId: string): Promise<void> {
  await db.delete(timelineSourceSync).where(and(
    eq(timelineSourceSync.userId, userId),
    eq(timelineSourceSync.sourceId, sourceId),
  ))
}

/**
 * 这个源要不要搬一次？（纯函数，单测直接钉）
 *
 * 判据按"宁可多搬一次空转，也不能漏"排：
 *   · 没有水位行 / 上次同步没成功（syncedAt 为空）→ 要搬（新订阅、上次失败）；
 *   · 源在**上次同步开始之后**又有过变化（feed 看 `lastChangedAt`、bot 看 `lastNewEntryAt`）→ 要搬。
 *     复制**不带任何参数**，所以"换设置 = 换哈希 = 重扫"这条判据不存在了。
 *
 * 注意比较的是"同步**开始**时刻"：复制进行中写入的条目，其 `lastChangedAt` 会大于开始时刻，
 * 于是这一轮仍判为脏、下一轮补搬 —— 用完成时刻会把它误判成"已同步过"而永久漏掉。
 */
export function sourceNeedsSync(input: {
  watermark: Pick<SourceSyncWatermark, "syncedAt"> | undefined
  sourceUpdatedAt: Date | null
}): boolean {
  if (!input.watermark) return true
  if (input.watermark.syncedAt == null) return true
  return input.sourceUpdatedAt != null && input.sourceUpdatedAt > input.watermark.syncedAt
}

/**
 * 订阅源的"最后一次内容变化"时间（一条 SQL 拿全部：每源一次请求在 600+ 源时不可接受）。
 *
 * feed 用 `lastChangedAt`（新增**或裁剪删除**），bot 用 `lastNewEntryAt`（bot 库不裁剪，见
 * `docs/notes/aggregation/source-side-retention-plan.md` §10.7）。
 * 老行可能还没回填 `last_changed_at`，回退到 `last_new_entry_at`。
 */
async function readSourceFreshness(sources: TimelineSource[]): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  const feedIds = sources.filter(source => source.kind === "feed").map(source => source.id)
  const botIds = sources.filter(source => source.kind === "bot").map(source => source.id.slice("bot:".length))
  if (feedIds.length > 0) {
    const rows = await db.select({ id: feeds.id, at: feeds.lastChangedAt, newAt: feeds.lastNewEntryAt })
      .from(feeds).where(inArray(feeds.id, feedIds))
    for (const row of rows) out.set(row.id, row.at ?? row.newAt)
  }
  if (botIds.length > 0) {
    const rows = await db.select({ id: botsTable.id, at: botsTable.lastNewEntryAt })
      .from(botsTable).where(inArray(botsTable.id, botIds))
    for (const row of rows) out.set(`bot:${row.id}`, row.at)
  }
  return out
}

export interface SourceSyncOutcome {
  sourceId: string
  /** 跳过（没搬也没推进水位）：订阅在排队期间被退掉了 */
  skipped?: "unsubscribed"
  /** 本次真正写进目标库的文档数（复制器报的） */
  docsWritten: number
  elapsedMs: number
  /** 这个源从没同步过（新订阅 / 水位被清）→ 这次是首搬，复制器会从 0 扫该源 */
  rebound: boolean
}

/**
 * 同步**单个源**：队列 job 的本体（见 workers/timeline-sync.ts）。
 *
 * 只收 (用户, 源 id) 两个参数：源类型与订阅文档 id 都能从 `subscription:<sourceId>` 这一份文档
 * 读出来（客户端写订阅用的就是这个 id），顺带还校验了"这条 job 排队期间有没有被退订"。
 *
 * 一次调用 = 一次一次性复制。顺序上先把水位写成"开始于 now + 正在同步"，再搬；搬成了才把
 * status 落回 idle 并把源库序号记下来，搬砸了把 syncedAt 清空并记 lastError ——
 * 清空保证下一轮还会把它判成脏源（BullMQ 同时也会按 attempts 重试）。
 *
 * 复制不带任何参数，所以这里没有"重算下界 / 换哈希"这一步：同一份过滤器源码的 checkpoint
 * 恒定，第二轮起只搬增量。
 */
export async function syncSubscriptionSource(input: {
  userId: string
  sourceId: string
}): Promise<SourceSyncOutcome> {
  const { userId, sourceId } = input
  const targetDb = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(targetDb)

  // 退订竞态：这条 job 可能是在退订前入队的，别把刚清理掉的内容又搬回来。
  // 404 = 订阅确实没了（正常）；**其它错误必须出声** —— 曾经有一次这里吞掉了一个 bad request，
  // 结果所有源都被静默判成"已退订"，聚合一条内容都不搬而日志里什么都没有。
  let subscription: { kind?: string } | null = null
  try {
    subscription = await scope.get(`subscription:${sourceId}`) as { kind?: string }
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode
    if (status !== 404) {
      console.warn(
        `[Timeline] 读订阅文档 subscription:${sourceId} 失败（按"已退订"跳过；`
        + `非 404 会在这里留痕）：${(err as Error)?.message ?? err}`,
      )
    }
    return { sourceId, skipped: "unsubscribed", docsWritten: 0, elapsedMs: 0, rebound: false }
  }
  const kind: TimelineSource["kind"] = subscription?.kind === "bot" ? "bot" : "feed"

  const sourceDb = kind === "bot"
    ? await ensureBotDatabase(sourceId.slice("bot:".length))
    : await ensureFeedDatabase(sourceId)

  const existing = await readSourceWatermark(userId, sourceId)
  // 复制**不带任何参数**，同一份过滤器源码的哈希恒定 → 只有"这个源从没同步过"才算 rebound
  const rebound = !existing

  const startedAt = new Date()
  await db.insert(timelineSourceSync).values({
    userId,
    sourceId,
    syncedAt: startedAt,
    status: "syncing",
    lastError: null,
  }).onConflictDoUpdate({
    target: [timelineSourceSync.userId, timelineSourceSync.sourceId],
    set: {
      syncedAt: startedAt,
      status: "syncing",
      lastError: null,
    },
  })

  try {
    const res = await runSourceReplication({ sourceDb, targetDb })
    await db.update(timelineSourceSync).set({
      syncedAt: startedAt,
      status: "idle",
      sourceSeq: res.sourceLastSeq,
      lastError: null,
    }).where(and(
      eq(timelineSourceSync.userId, userId),
      eq(timelineSourceSync.sourceId, sourceId),
    ))
    if (rebound) {
      // 只记「首搬」：稳态增量每轮可能有上百个源，逐个记会把流水刷爆（源级状态看源状态表）
      await recordTimelineEvent({
        userId,
        kind: "source-sync",
        message: `首次同步源 ${sourceId}：搬入 ${res.docsWritten} 份（${res.elapsedMs}ms）`,
        data: { sourceId, docsWritten: res.docsWritten, elapsedMs: res.elapsedMs },
      })
    }
    return { sourceId, docsWritten: res.docsWritten, elapsedMs: res.elapsedMs, rebound }
  } catch (err) {
    const message = ((err as Error)?.message ?? String(err)).slice(0, 500)
    await db.update(timelineSourceSync).set({
      syncedAt: null,
      status: "error",
      lastError: message,
    }).where(and(
      eq(timelineSourceSync.userId, userId),
      eq(timelineSourceSync.sourceId, sourceId),
    )).catch(() => {})
    await recordTimelineEvent({
      userId,
      kind: "error",
      level: "error",
      message: `源 ${sourceId} 同步失败：${message}`,
      data: { sourceId, error: message },
    })
    throw err
  }
}

export interface TimelineReconcileResult {
  userId: string
  /** 订阅源总数 */
  sources: number
  /** 本轮判定需要搬运的源（调用方交给 rss-timeline-sync 队列，限并发跑一次性复制） */
  dirtySources: string[]
  /** 因退订清掉的水位行数（= 已不再订阅的源数） */
  removedSyncs: number
  /** 因退订删除的条目数 */
  removedEntries: number
  /** 清理掉的遗留**常驻**复制任务数（升级一次性动作，之后恒为 0） */
  purgedReplications: number
  /** 逐源失败的原因（不阻塞其余源） */
  failures: Array<{ sourceId: string, error: string }>
}

/**
 * 把一个用户的聚合库对齐到「当前订阅集合」。
 *
 * 顺序是有意的：① 换库重搬（仅 v1 → v2 升级）→ ② 水位失效（库是空的/刚换的）→ ③ 退订清理
 * → ④ 清理遗留常驻任务 → ⑤ 脏源判定 → ⑥ 写状态。**这里不搬数据**：需要搬的源只是
 * 被列进 `dirtySources`，由调用方入队（见 workers/timeline-sync.ts），搬运本身跑在队列的
 * 限并发 worker 里 —— 这是"不再一次几百个源同时冲"的关键。
 *
 * 单个源失败只记进 failures：一个源的库抖动不该让剩下几百个源都不同步。
 */
export async function reconcileUserTimeline(
  userId: string,
  options: { force?: boolean } = {},
): Promise<TimelineReconcileResult> {
  return await withUserLock(userId, () => reconcileUserTimelineUnlocked(userId, options))
}

/** reconcile 本体（调用方必须已经持有该用户的锁） */
async function reconcileUserTimelineUnlocked(
  userId: string,
  options: { force?: boolean } = {},
): Promise<TimelineReconcileResult> {
  const startedAt = Date.now()
  let dbName = await ensureTimelineDatabase(userId)
  let scope = createCouchDb(dbName)
  let state = await readTimelineState(dbName)

  // ① v1 → v2 一次性升级：老库里服务端独占文档带的是我们自己的修订，留着会和复制器搬来的
  //    修订谱系冲突；而"就地清空再重搬"做不到（目标端删过的 rev 复制器不会再送）。所以换成
  //    一个空库重搬（用户自己写的状态文档跟着搬过去），后面的 ⑥ 会把源全判成脏源重搬一遍。
  const upgraded = state.version < STATE_VERSION
  if (upgraded) {
    dbName = await rederiveUserTimeline(userId, dbName)
    scope = createCouchDb(dbName)
    state = await readTimelineState(dbName)
  }

  const sources = await listSubscriptionSources(userId)
  const subscribed = new Set(sources.map(source => source.id))

  const result: TimelineReconcileResult = {
    userId,
    sources: sources.length,
    dirtySources: [],
    removedSyncs: 0,
    removedEntries: 0,
    purgedReplications: 0,
    failures: [],
  }

  // ② 水位只在"这个库确实已经有内容"时才有意义。库是空的/刚换过的（升级、重建、手工删库）就
  //    整份作废：否则那些"源那边没有新内容"的源永远不会被搬，聚合库会一直空着。
  let watermarks = await readSourceWatermarks(userId)
  if (upgraded || await isDerivedDbFresh(dbName)) {
    if (watermarks.size > 0) await clearSourceWatermarks(userId)
    watermarks = new Map()
  }

  // ③ 退订清理：有水位行但已不在订阅集合里 —— 有水位行就说明这个源曾经同步过（同步前会先写行），
  //    所以它同时也是"该源在库里可能有内容"的凭据。
  for (const sourceId of [...watermarks.keys()]) {
    if (subscribed.has(sourceId)) continue
    try {
      const prefix = entryIdPrefix(sourceId)
      result.removedEntries += await deleteByPrefix(scope, prefix, `${prefix}\uffff`)
      await deleteDocIfExists(scope, sourceId)
      await deleteSourceWatermark(userId, sourceId)
      result.removedSyncs += 1
    } catch (err) {
      result.failures.push({ sourceId, error: (err as Error)?.message ?? String(err) })
    }
  }

  // ④ 用户库**不再剪枝**：保留策略的唯一权威是源库裁剪（每条源只留最新 N 条）——
  //    源库删掉的条目会跟着复制传播过来，用户库因此是精确镜像，不需要自己再挑一遍
  //    （见 docs/notes/aggregation/source-side-retention-plan.md）。
  //    这一步原来每轮都要扫用户库全部条目，是整个聚合链路里唯一随数据量恶化的成本。

  // ⑤ 升级清理：老版本给每个 (用户 × 源) 建了一条**常驻**复制，它们会继续占槽位与长轮询、
  //    还会和新的一次性复制抢复制器，所以升级后一次性删干净。靠状态文档里的标记只做一次。
  if (!state.replicatorsPurged) {
    try {
      result.purgedReplications = await purgeLegacyReplications(userId)
      state.replicatorsPurged = true
      if (result.purgedReplications > 0) {
        console.log(`[Timeline] 用户=${userId} 清理遗留常驻复制 ${result.purgedReplications} 条`)
      }
    } catch (err) {
      // 清不掉不算失败：下一轮再试（标记没写，所以每轮都会重试）
      console.warn(`[Timeline] 用户=${userId} 清理遗留常驻复制失败（下轮重试）：${(err as Error)?.message ?? err}`)
    }
  }

  // ⑥ 脏源判定：新订阅 / 上次失败 / 源那边在上次同步开始后有变化。没变化的源**不**入队。
  //    force = 跳过水位，把当前订阅的源全部重扫一遍（运维/验证逃生口：默认路径下"源库被外部
  //    直接写过、但 PG 的 lastNewEntryAt 没动"这种情况是判不出来的，此时只能显式重扫）。
  const freshness = await readSourceFreshness(sources)
  for (const source of sources) {
    if (options.force || sourceNeedsSync({
      watermark: watermarks.get(source.id),
      sourceUpdatedAt: freshness.get(source.id) ?? null,
    })) {
      result.dirtySources.push(source.id)
    }
  }

  // ⑦ 写回状态（只剩版本号与升级清理标记）
  state.version = STATE_VERSION
  await writeTimelineState(dbName, state)

  // ⑧ 流水：这一轮到底做了什么。用户在设置页 →「同步日志」里能看到（旁路，写失败不影响聚合）
  await recordTimelineEvent({
    userId,
    kind: "reconcile",
    level: result.failures.length > 0 ? "warn" : "info",
    message: describeReconcileRound(result, Date.now() - startedAt),
    data: {
      sources: result.sources,
      dirty: result.dirtySources.length,
      removedSyncs: result.removedSyncs,
      removedEntries: result.removedEntries,
      purgedReplications: result.purgedReplications,
      failures: result.failures.length,
      ms: Date.now() - startedAt,
    },
  })

  return result
}

/**
 * 一轮汇聚的人话描述（给设置页的同步日志看）。
 *
 * 常态是"无事发生"，所以空转也要记一行、但要短 —— 用户问的是"什么时候触发了汇聚"，
 * 只记有事发生的轮次就等于看不见定时器还在不在跑。
 */
function describeReconcileRound(result: TimelineReconcileResult, ms: number): string {
  const parts: string[] = []
  if (result.dirtySources.length > 0) parts.push(`${result.dirtySources.length} 个源需搬运`)
  if (result.removedSyncs > 0 || result.removedEntries > 0) {
    parts.push(`退订清理 ${result.removedSyncs} 个源 / ${result.removedEntries} 条`)
  }
  if (result.purgedReplications > 0) parts.push(`清掉 ${result.purgedReplications} 条遗留常驻复制`)
  if (result.failures.length > 0) parts.push(`${result.failures.length} 个源失败`)
  const detail = parts.length > 0 ? parts.join("；") : "无需搬运"
  return `汇聚：订阅 ${result.sources} 个源，${detail}（${ms}ms）`
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
 * `_local` 里）一起消失，新任务会从 0 扫源库、把当前内容（每源最新 N 条）完整重搬一遍。
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

  // 旧库上的复制任务全部作废：目标库换了。新实现不再建常驻任务，升级路径上可能还留着老的 ——
  // 那些由 reconcile 的 ⑤ 统一清（这里不重复清，免得每次换库多跑一轮 `_replicator` 列举）

  // 旧库已经没用了（新库接管），删掉省空间；删失败不影响正确性
  try {
    await nanoServer.db.destroy(oldDbName)
  } catch {
    // 旧库已被删/正被删：忽略
  }

  console.log(`[Timeline] 用户=${userId} 换库重搬：${oldDbName} → ${newDbName}（搬走用户状态 ${copied} 条）`)
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

/** 读派生库当前的 `update_seq`（手动同步用它锁定"从哪儿开始数新增条目"） */
export async function readTimelineUpdateSeq(userId: string): Promise<string | number> {
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)
  return (await scope.info() as { update_seq?: string | number }).update_seq ?? 0
}

/**
 * 等派生库安静下来（「手动同步」的 `wait=1` 的最后一段）。
 *
 * 搬运是异步的（现在由 `rss-timeline-sync` 队列跑），所以等待的判据是**派生库自己的 `_changes`**：
 * 从给定序号往后读增量，连续若干轮没有新条目就认为追平了。
 *
 * 调用方的正确姿势（见 routes/timeline.ts）：
 *   ① 入队前先 `readTimelineUpdateSeq` 拿到起始序号；
 *   ② 等入队的同步任务跑完（`waitForSourceSyncs`）；
 *   ③ 再调本函数，并传 `sinceSeq` + `quietRounds: 1` / `minWaitMs: 0` —— 任务都跑完了，
 *      剩下的只是"把这段时间进来的条目数一遍"，不需要再靠保守等待去猜。
 *
 * 默认值（`minWaitMs` 4s / `quietRounds` 5）是给上面第 ② 步不可用时的老场景兜底的：
 * 任务刚建好时复制器还没开始写，派生库就是"安静的"，不设最短等待就会立刻返回 added=0。
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
  options: {
    quietRounds?: number
    pollIntervalMs?: number
    minWaitMs?: number
    /**
     * 从这里开始数新增条目（默认取当前 update_seq）。
     *
     * 手动同步（`?wait=1`）的用法是：**入队前**先取一次序号传进来，等队列里的同步任务跑完再调本函数，
     * 于是这一批到底搬进来多少条能被准确数出来；如果在这里才取序号，条目早已写完，会数成 0。
     */
    sinceSeq?: string | number
  } = {},
): Promise<{ completed: boolean, added: number }> {
  const quietRounds = options.quietRounds ?? 5
  const pollIntervalMs = options.pollIntervalMs ?? 400
  const minWaitMs = options.minWaitMs ?? 4000
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)

  let since: string | number = options.sinceSeq
    ?? (await scope.info() as { update_seq?: string | number }).update_seq
    ?? 0
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
 * 重建聚合库：换一个空库、把源库内容完整重搬一遍，用户状态跟着走。
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
  await recordTimelineEvent({
    userId,
    kind: "rebuild",
    level: "warn",
    message: `开始重建聚合库（换一个新库重搬，旧库 ${oldDbName} 稍后删除）`,
    data: { oldDbName },
  })
  await rederiveUserTimeline(userId, oldDbName)
  // 新库没有状态文档 → reconcile 的 ② 会把水位整份作废、所有源重新入队重搬一遍，
  // 同时 ⑤ 会把遗留的常驻复制任务清掉（那是升级动作，新库的标记还没写）
  const result = await reconcileUserTimelineUnlocked(userId)
  await recordTimelineEvent({
    userId,
    kind: "rebuild",
    message: `重建完成：${result.sources} 个源全部重新回填（${result.dirtySources.length} 个已入队）`,
    data: { sources: result.sources, dirty: result.dirtySources.length },
  })
  return result
}

/** 所有用户 id（定时 reconcile 用；自建服务用户量小，一次全查没有问题） */
export async function listUserIds(): Promise<string[]> {
  const rows = await db.select({ id: user.id }).from(user)
  return rows.map(row => row.id)
}
