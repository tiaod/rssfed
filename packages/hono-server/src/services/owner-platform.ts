import { and, eq, isNull, sql } from "drizzle-orm"
import { db, user, bots as botsTable, userTimelineSettings } from "../db"
import { ensureBotDatabase, ensureTimelineDatabase } from "../couchdb/client"
import type { FetchOwnerJob } from "../workers"
import { fetchIntervalMs, type FeedScheduleState, type FetchScheduleOptions } from "../workers/fetch-schedule"
import { readSchedule, writeSchedule, type ScheduleState } from "./owner-schedule"
import {
  computeActivityBytesPerDay,
  nextRetentionEntries,
  RETENTION_MIN_SAMPLE_ENTRIES,
  type FeedActivitySnapshot,
} from "./feed-retention-policy"
import { trimOwnerFeedToLatestN, USER_TIMELINE_TRIM_VIEW, DEFAULT_SOURCE_RETENTION_ENTRIES } from "../couchdb/retention"
import { createCouchDb } from "../couchdb/client"

/**
 * 「抓取对象」的平台侧：有哪些 owner 要抓、哪些在休眠、每个源的保留条数该多大。
 *
 * 这些事都需要 PostgreSQL（用户表、Bot 表、休眠标记），而抓取链路本身不碰 PG ——
 * 分成两个模块是为了让 `workers/index.ts` 的调度逻辑只关心"谁该抓"，
 * 不必知道用户/设置的存储形态。
 */

/** 一个待抓取的 owner */
export interface ScheduleTarget {
  owner: FetchOwnerJob
  /** owner 的库名（读订阅与 schedule 的状态都要它） */
  dbName: string
  /** 已休眠：完全不抓 */
  paused: boolean
}

/**
 * 枚举所有需要参与调度的 owner。
 *
 * - **用户**：有 `timeline_db_name` 的（从没建过库 = 从没订阅过，跳过）。休眠的不抓。
 * - **Bot**：`is_active` 的。Bot 没有"休眠"概念（它的产出是持续对外发布的）。
 */
export async function collectScheduleTargets(): Promise<ScheduleTarget[]> {
  const users = await db.select({
    id: user.id,
    dbName: user.timelineDbName,
    pausedAt: userTimelineSettings.aggregationPausedAt,
  })
    .from(user)
    .leftJoin(userTimelineSettings, eq(userTimelineSettings.userId, user.id))

  const bots = await db.select({ id: botsTable.id, dbName: botsTable.couchDbName })
    .from(botsTable)
    .where(eq(botsTable.isActive, true))

  const targets: ScheduleTarget[] = []
  for (const row of users) {
    if (!row.dbName) continue
    targets.push({
      owner: { kind: "user", id: row.id },
      dbName: row.dbName,
      paused: row.pausedAt != null,
    })
  }
  for (const row of bots) {
    if (!row.dbName) continue
    targets.push({
      owner: { kind: "bot", id: row.id },
      dbName: row.dbName,
      paused: false,
    })
  }
  return targets
}

/**
 * 把长期不活跃的用户标成"暂停抓取"。
 *
 * 新模型下休眠**只省 egress 与写库**，不需要任何重建：回来后下一轮调度照常抓，
 * 缺的内容随那次抓取补上（与旧模型"回来必须换库重搬"完全不同）。
 *
 * 活跃度判定按优先级：本服务记录的 `last_active_at` → Better Auth 的会话最近更新时间 →
 * 账号创建时间。用会话兜底是为了功能刚上线时 `last_active_at` 还全是空：
 * 至少不会把三年没登录的账号当成"刚刚注册"。
 *
 * @param days 多少天没活动算休眠（<=0 = 关闭）
 * @returns 本次新暂停的用户 id
 */
export async function pauseDormantOwners(
  days: number,
  options: { now?: Date, limit?: number } = {},
): Promise<string[]> {
  if (!Number.isFinite(days) || days <= 0) return []
  const now = options.now ?? new Date()
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000))
  const cutoff = new Date(now.getTime() - days * 86_400_000)

  // 只处理「有库、还没暂停」的用户：零订阅用户暂停没有收益（本来也没源可抓）
  const candidates = await db.select({
    id: user.id,
    dbName: user.timelineDbName,
    lastActiveAt: userTimelineSettings.lastActiveAt,
  })
    .from(user)
    .leftJoin(userTimelineSettings, eq(userTimelineSettings.userId, user.id))
    .where(and(
      isNull(userTimelineSettings.aggregationPausedAt),
      sql`${user.timelineDbName} is not null`,
    ))
    .limit(limit)

  const paused: string[] = []
  for (const row of candidates) {
    const reference = row.lastActiveAt ?? null
    if (reference && reference > cutoff) continue
    if (!reference) {
      // 从没上报过活跃度：不判休眠（宁可多抓，也不要误停一个刚注册的账号）
      continue
    }
    await db.insert(userTimelineSettings)
      .values({ userId: row.id, aggregationPausedAt: now })
      .onConflictDoUpdate({
        target: userTimelineSettings.userId,
        set: { aggregationPausedAt: now },
      })
    paused.push(row.id)
  }
  return paused
}

/** 用户回来 → 清掉休眠标记（不需要重建，下一轮调度自然抓） */
export async function resumeOwner(userId: string): Promise<boolean> {
  const rows = await db.update(userTimelineSettings)
    .set({ aggregationPausedAt: null })
    .where(and(eq(userTimelineSettings.userId, userId), sql`${userTimelineSettings.aggregationPausedAt} is not null`))
    .returning({ userId: userTimelineSettings.userId })
  return rows.length > 0
}

/** 读该 owner 库的活跃度快照（source = 该库里这个源那部分条目） */
export async function readOwnerFeedActivity(
  dbName: string,
  feedId: string,
): Promise<FeedActivitySnapshot | null> {
  const db = createCouchDb(dbName)
  const [design, view] = USER_TIMELINE_TRIM_VIEW.split("/") as [string, string]

  let newestKey: unknown
  let oldestKey: unknown
  let docCount = 0
  let externalBytes = 0

  try {
    const [newest, oldest] = await Promise.all([
      db.view(design, view, { startkey: [feedId, ""], endkey: [feedId, {}], limit: 1, descending: true, include_docs: false }),
      db.view(design, view, { startkey: [feedId, ""], endkey: [feedId, {}], limit: 1, include_docs: false }),
    ])
    newestKey = (newest?.rows?.[0] as { key?: unknown } | undefined)?.key
    oldestKey = (oldest?.rows?.[0] as { key?: unknown } | undefined)?.key
    // total_rows 是整库行数（这个视图没有 reduce），所以只能靠实际行数：
    // 用 group=true 拿到该源那一条的计数太贵，直接查这一组（N ≤ 50，很便宜）
    const group = await db.view(design, view, {
      startkey: [feedId, ""],
      endkey: [feedId, {}],
      include_docs: false,
      limit: 1_000,
    })
    const rows = group?.rows ?? []
    docCount = rows.length
    // 体积按文档数估算：逐文档取字节要读正文，代价远超收益。
    // 分档只需要"日均新增字节"的量级，用固定均值（20KB/条，含附件）足够区分四档。
    externalBytes = docCount * 20 * 1024
  } catch {
    // 视图缺失 / 库忙：本轮不判断
    return null
  }

  return {
    externalBytes,
    docCount,
    newestPublishedAt: keyTime(newestKey),
    oldestPublishedAt: keyTime(oldestKey),
  }
}

function keyTime(key: unknown): string | undefined {
  if (Array.isArray(key) && typeof key[1] === "string") return key[1]
  if (typeof key === "string") return key
  return undefined
}

/**
 * 为某 owner 库里的所有源重算保留条数（自适应，每天一轮）。
 *
 * 输入是**这个 owner 库里这个源那一组条目**的活跃度 —— 与旧模型的"源库活动度"不同：
 * 同一个源被 A、B 两个用户订阅时，两人的阅读量可能差很多（A 从不点开），
 * 各自算各自的 N 才对。
 *
 * 一次最多变一档（`nextRetentionEntries` 的滞回），避免单日尖峰把历史一次删光。
 * 算完立刻按新 N 裁一次（缩小 N 时用户库才能真的变小）。
 */
export async function recomputeOwnerRetention(
  dbName: string,
  options: { dryRun?: boolean, now?: Date, maxSources?: number } = {},
): Promise<{ sources: number, changed: number, shrunk: number, trimmed: number }> {
  const schedule = await readSchedule(dbName).catch(() => null)
  const sources = schedule?.sources ?? {}
  const feedIds = Object.keys(sources)
  const now = options.now ?? new Date()
  const result = { sources: 0, changed: 0, shrunk: 0, trimmed: 0 }

  const limited = options.maxSources ? feedIds.slice(0, options.maxSources) : feedIds
  for (const feedId of limited) {
    const snapshot = await readOwnerFeedActivity(dbName, feedId)
    if (!snapshot || snapshot.docCount < RETENTION_MIN_SAMPLE_ENTRIES) continue
    result.sources += 1
    const bytesPerDay = computeActivityBytesPerDay(snapshot)
    const previous = sources[feedId]?.retentionEntries ?? null
    const next = nextRetentionEntries(previous, bytesPerDay)
    if (next === previous) continue
    result.changed += 1
    if (next < (previous ?? DEFAULT_SOURCE_RETENTION_ENTRIES)) result.shrunk += 1
    if (options.dryRun) continue

    sources[feedId] = {
      ...sources[feedId],
      retentionEntries: next,
      retentionComputedAt: now.toISOString(),
    }
    // 缩小 N 时立刻裁：否则要等到下一次抓取这个源才会收敛
    if (next < (previous ?? DEFAULT_SOURCE_RETENTION_ENTRIES)) {
      try {
        result.trimmed += await trimOwnerFeedToLatestN(dbName, feedId, next)
      } catch {
        // 裁失败不影响 N 的写入：下一轮抓取时会再裁一次
      }
    }
  }

  if (!options.dryRun && result.changed > 0) {
    await writeSchedule(dbName, { version: schedule?.version ?? 1, sources })
  }
  return result
}

/** 计算某源下次该用的抓取间隔（诊断/日志用；调度实际走 isFeedDue） */
export function nextFetchInterval(
  state: FeedScheduleState,
  options: FetchScheduleOptions,
  now = Date.now(),
): number {
  return fetchIntervalMs(state, options, now)
}

/** 该 owner 库里已知的源数（统计用） */
export async function countOwnerSources(dbName: string): Promise<number> {
  const state: ScheduleState | null = await readSchedule(dbName).catch(() => null)
  return Object.keys(state?.sources ?? {}).length
}
