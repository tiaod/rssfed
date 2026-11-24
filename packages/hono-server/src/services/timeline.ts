import type { DocumentScope } from "nano"
import { eq } from "drizzle-orm"
import { db, userTimelineSettings, type NewUserTimelineSettings } from "../db"
import { createCouchDb, createTimelineDatabase, ensureTimelineDatabase } from "../couchdb/client"
import { buildPurgeBody, countPurged, purgeRequest } from "../couchdb/retention"
import { dropSourceSchedule } from "./owner-schedule"

/**
 * 用户时间线的服务层：设置、退订清理、换库。
 *
 * ## 与旧版本的根本差别
 *
 * 旧版本这里是**聚合引擎**（1046 行）：维护「用户库 = 他所订阅源当前内容的集合」这份拓扑，
 * 靠 CouchDB 复制器按需搬运、用 PG 水位判断脏源、两侧各自执行保留策略。
 *
 * 新模型里**没有可聚合的东西** —— 抓取本身就按 owner 直接写进用户库，条目到达即到端。
 * 所以这里只剩三件事：
 *
 *   1. 每用户设置（AI 摘要开关等）；
 *   2. **退订清理**：把某源的订阅文档、条目、FeedDoc 副本、调度状态一起清掉；
 *   3. **换库**：档案损坏时另起一个空库，用户状态文档搬过去。
 *
 * ## 一条必须成立的性质
 *
 * 用户库里的 `entry:{feedId}:{hash}` 的 `feedId` 前缀是**退订清理的唯一依据**：
 * 按前缀范围 `_purge` 就能精确删掉某个源的全部条目，不必扫描全库。
 * 这个前缀由 `deriveFeedId(url)` 决定，与 owner 无关，所以跨用户一致。
 */

// ── 每用户设置 ──

/** 用户可调的设置。**保留策略不在这里** —— 它按 (用户 × 源) 自适应，存在 `_local/schedule`。 */
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

/** 写入用户设置（UPSERT），返回生效后的设置 */
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

// ── 退订清理 ──

/** 源 id 对应的条目 `_id` 前缀（退订时按它做范围删除） */
export function entryIdPrefix(sourceId: string): string {
  return sourceId.startsWith("bot:")
    ? `entry:bot:${sourceId.slice("bot:".length)}:`
    : `entry:${sourceId}:`
}

/** 按 id 前缀范围 `_purge` 一批文档（返回清掉的条数） */
async function purgeByPrefix(
  dbName: string,
  scope: DocumentScope<unknown>,
  startkey: string,
  endkey: string,
): Promise<number> {
  let deleted = 0
  // 每轮最多 200 批 × 500 条：一个源在用户库里最多 N 条（N ≤ 50），这个上限只是防御
  for (let page = 0; page < 200; page++) {
    let rows: Array<{ id: string, value: { rev: string } }>
    try {
      const res = await scope.list({ startkey, endkey, limit: 500, include_docs: false })
      rows = res.rows as Array<{ id: string, value: { rev: string } }>
    } catch {
      break
    }
    if (rows.length === 0) break
    const body = buildPurgeBody(rows.map((row) => ({ _id: row.id, _rev: row.value?.rev })).filter((doc) => Boolean(doc._rev)))
    if (Object.keys(body).length === 0) break
    const purged = await purgeRequest(dbName, body)
    const removed = countPurged(purged, body)
    deleted += removed
    // 一条都没清掉 = 撞上并发（文档刚被改过），停手让下一轮再来
    if (removed === 0) break
  }
  return deleted
}

/** 删文档（不存在不算错） */
async function deleteDocIfExists(scope: DocumentScope<unknown>, id: string): Promise<boolean> {
  try {
    const doc = await scope.get(id) as { _rev: string }
    await scope.destroy(id, doc._rev)
    return true
  } catch {
    return false
  }
}

export interface UnsubscribeCleanupResult {
  /** 清掉的条目数 */
  removedEntries: number
  /** 是否删掉了 FeedDoc 副本 */
  removedFeedDoc: boolean
  /** 是否删掉了订阅文档（调用方可能已经删过了） */
  removedSubscription: boolean
}

/**
 * 退订清理：把一个源在该用户库里的**全部痕迹**清掉。
 *
 * 顺序是刻意的：
 *   1. 先删**订阅文档** —— 它是"退订"的权威信号，后续即使有并发抓取也会先读它跳过；
 *   2. 再按前缀 purge 条目（`_purge` 不留墓碑，标准 delete 会留）；
 *   3. 删 FeedDoc 副本（否则侧边栏还会显示这个源的标题/图标）；
 *   4. 最后清 `_local/schedule` 里的状态（重新订阅时不会继承旧的 lastFetchedAt）。
 *
 * 任何一步失败都不影响其余步骤：重试的代价只是多扫一次范围。
 */
export async function purgeSubscriptionContent(
  userId: string,
  feedId: string,
): Promise<UnsubscribeCleanupResult> {
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)
  const result: UnsubscribeCleanupResult = {
    removedEntries: 0,
    removedFeedDoc: false,
    removedSubscription: false,
  }

  // ① 订阅文档
  result.removedSubscription = await deleteDocIfExists(scope, `subscription:${feedId}`).catch(() => false)

  // ② 条目（按 `entry:{feedId}:` 前缀范围）
  const prefix = entryIdPrefix(feedId)
  result.removedEntries = await purgeByPrefix(dbName, scope, prefix, `${prefix}\uffff`)

  // ③ FeedDoc 副本（id 规则见 couchdb/doc-ids.ts：下划线开头的 feedId 加了 `feed` 前缀）
  const { feedDocId } = await import("../couchdb/doc-ids")
  result.removedFeedDoc = await deleteDocIfExists(scope, feedDocId(feedId)).catch(() => false)

  // ④ 调度状态
  await dropSourceSchedule(dbName, feedId)

  return result
}

/**
 * 批量退订清理（OPML 覆盖式导入、账号清理等场景）。
 *
 * 串行执行而不是并发：同一个库上的 `_purge` 并发只会互相竞争，收益接近零。
 */
export async function purgeSubscriptionsContent(
  userId: string,
  feedIds: string[],
): Promise<{ removedEntries: number, sources: number }> {
  let removedEntries = 0
  let sources = 0
  for (const feedId of feedIds) {
    try {
      const result = await purgeSubscriptionContent(userId, feedId)
      removedEntries += result.removedEntries
      sources += 1
    } catch (err) {
      console.warn(`[Timeline] 退订清理 ${feedId} 失败：${(err as Error)?.message ?? err}`)
    }
  }
  return { removedEntries, sources }
}

// ── 换库（抢救） ──

/** 换库时每批搬运的文档数（`_all_docs` 一页 + `_bulk_docs` 一次） */
const INTENT_COPY_BATCH = 500
/** 换库时最多搬多少页（每页 500，够一个用户的订阅 + 已读收藏量级） */
const INTENT_COPY_MAX_PAGES = 400

/**
 * 用户自己写的文档要不要搬？—— 服务端抓取产物**不搬**，用户状态搬。
 *
 * 判据是 `_id` 前缀而不是 `type`：墓碑没有 type 字段，而删除也要跟着走
 * （否则新库里会复活已被删掉的订阅/已读记录）。
 */
function shouldCopyToNewDb(id: string): boolean {
  return id.startsWith("subscription:")
    || id.startsWith("entry-state:")
    || id.startsWith("group-pref:")
}

/**
 * 另起一个空库并把用户状态文档搬过去，返回新库名。
 *
 * 只在「档案损坏、需要从零开始」时用。与旧模型的区别：抓取产物不再从别处搬
 * （没有源库了），所以新库里一开始**没有条目**，要等下一轮抓取才慢慢填回来。
 * 这是抢救场景的已知代价。
 */
export async function rederiveUserTimeline(userId: string, oldDbName: string): Promise<string> {
  const newDbName = await createTimelineDatabase(userId)
  const oldScope = createCouchDb(oldDbName)
  const newScope = createCouchDb(newDbName)

  for (let page = 0; page < INTENT_COPY_MAX_PAGES; page++) {
    let rows: Array<{ id: string, doc?: Record<string, unknown> }>
    try {
      const res = await oldScope.list({
        include_docs: true,
        limit: INTENT_COPY_BATCH,
        ...(page === 0 ? {} : { skip: page * INTENT_COPY_BATCH }),
      })
      rows = res.rows as Array<{ id: string, doc?: Record<string, unknown> }>
    } catch {
      break
    }
    const docs = rows
      .filter((row) => shouldCopyToNewDb(row.id))
      .map((row) => {
        const doc = row.doc ?? {}
        // 去掉修订相关字段：新库里这些是**新文档**（不是修订谱系的一部分）
        const { _rev: _rev, _revisions: _revisions, ...rest } = doc
        return rest
      })
    if (docs.length > 0) {
      await newScope.bulk({ docs } as never).catch(() => {})
    }
    if (rows.length < INTENT_COPY_BATCH) break
  }
  return newDbName
}

/** 清掉某用户库里的服务端抓取产物（条目与 FeedDoc 副本），保留订阅与阅读状态 */
export async function purgeFetchedContent(userId: string): Promise<number> {
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)
  let deleted = 0

  // 条目：`entry:` 整个前缀（含 bot 条目 `entry:bot:...`）
  deleted += await purgeByPrefix(dbName, scope, "entry:", "entry:\uffff")

  // FeedDoc 副本：id 是裸 feedId 或 `feed`+feedId（没有统一前缀，只能按 type 找）。
  // 每轮清一批并重新查询 —— `_purge` 之后 find 的结果集自然收缩，直到找不到为止。
  for (let round = 0; round < 200; round++) {
    let docs: Array<{ _id: string, _rev: string }>
    try {
      const res = await scope.find({
        selector: { type: "feed" },
        fields: ["_id", "_rev"],
        limit: 500,
      })
      docs = (res.docs ?? []) as unknown as Array<{ _id: string, _rev: string }>
    } catch {
      break
    }
    if (docs.length === 0) break
    const body = buildPurgeBody(docs.map((doc) => ({ _id: doc._id, _rev: doc._rev })))
    const purged = await purgeRequest(dbName, body)
    const removed = countPurged(purged, body)
    deleted += removed
    // 一条都没清掉 = 撞上并发，停手
    if (removed === 0) break
  }
  return deleted
}

/** 该用户库当前的 update_seq（客户端手动同步用它锁定"从哪儿开始数新增条目"） */
export async function readTimelineUpdateSeq(userId: string): Promise<string | number> {
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)
  return (await scope.info() as { update_seq?: string | number }).update_seq ?? 0
}

/**
 * 等本地库在 `sinceSeq` 之后"安静下来"，返回新增了多少条**条目**。
 *
 * 新模型里条目是由抓取 job **直接写进用户库**的（没有复制器），所以判据从"复制任务跑完没"
 * 变成"库里多久没有新的 `entry:` 写入了"。`quietRounds` 次轮询都没新条目即认为追平。
 *
 * 超时不算失败：抓取仍在后台继续，条目会在之后陆续到端（客户端靠 live 通道接收）。
 */
export async function waitForSync(
  userId: string,
  timeoutMs: number,
  options: {
    quietRounds?: number
    pollIntervalMs?: number
    minWaitMs?: number
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
      // 「安静」+ 「已经等够最短时间」才敢说追平了（否则任务可能还没开始写）
      if (quiet >= quietRounds && Date.now() - startedAt >= minWaitMs) return { completed: true, added }
    } else {
      quiet = 0
    }
  }
  return { completed: false, added }
}

/** 该用户是否处于休眠（休眠期间不抓取） */
export async function isUserAggregationPaused(userId: string): Promise<boolean> {
  const [row] = await db.select({ pausedAt: userTimelineSettings.aggregationPausedAt })
    .from(userTimelineSettings)
    .where(eq(userTimelineSettings.userId, userId))
    .limit(1)
  return row?.pausedAt != null
}

/** 供路由使用的「清空并重建」入口（换库 + 清抓取产物） */
export async function resetUserTimeline(userId: string): Promise<{ dbName: string, removedEntries: number }> {
  const oldDbName = await ensureTimelineDatabase(userId)
  const removedEntries = await purgeFetchedContent(userId)
  const dbName = await rederiveUserTimeline(userId, oldDbName)
  return { dbName, removedEntries }
}

/** 兼容旧名：旧调用方按 "reconcile" 语义引用的地方只是想要一次设置读取 */
export const reconcileUserTimeline = async (userId: string) => ({ userId, settings: await getTimelineSettings(userId) })
export type TimelineReconcileResult = Awaited<ReturnType<typeof reconcileUserTimeline>>

/** 兼容旧名：旧调用方用它在用户库里"读订阅源"；现在是 owner-fetch 的 collectOwnerSources */
export { entryIdPrefix as sourceEntryPrefix }
