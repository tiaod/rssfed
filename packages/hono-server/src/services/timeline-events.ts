import { and, desc, eq, inArray, sql } from "drizzle-orm"
import {
  bots as botsTable,
  db,
  feeds,
  timelineEvents,
  timelineReconcileHeartbeat,
  timelineSourceSync,
} from "../db"

/**
 * 聚合流水：把"这一轮到底发生了什么"从服务端控制台搬到用户能看见的地方（设置页 → 同步日志）。
 *
 * 三条明确的设计取舍（都来自实测：首版 4 小时记了 671 条，其中 564 条是纯空转）：
 *   1. **空转不记流水**。定时器 5 分钟一轮，绝大多数轮次什么都没变；这些轮次只更新一行
 *      `timeline_reconcile_heartbeat`（心跳），流水留给真正干了活的轮次。
 *   2. **活跃期的连续轮次合并成一条**。抓取循环期间每 30 秒就可能有一轮"搬了 1 个源"，
 *      逐条记还是会刷屏；窗口内（`RECONCILE_MERGE_WINDOW_MS`）的同类轮次并成一条
 *      「连续 N 轮，共 M 个源需搬运」。
 *   3. **只记离散动作，不记每个源**。源级"现在什么样"直接读 `timeline_source_sync`。
 *
 * 写流水是**旁路**：内部吞异常，日志写不进去绝不影响聚合本身。
 */

/** 每用户保留多少条流水（合并后一天也就几十条，2000 条 ≈ 一个月） */
export const TIMELINE_EVENT_KEEP = 2000

/** 连续"有变化"的汇聚在这个窗口内合并成一条（活跃抓取期一轮几十秒） */
export const RECONCILE_MERGE_WINDOW_MS = 5 * 60_000

export type TimelineEventKind = "reconcile" | "rebuild" | "source-sync" | "error"
export type TimelineEventLevel = "info" | "warn" | "error"

export interface TimelineEventRow {
  id: number
  at: Date
  kind: string
  level: string
  message: string
  /** 结构化补充（数字/源 id 等），客户端可以展开看 */
  data: unknown
}

export interface TimelineHeartbeat {
  /** 最近一轮聚合（不论有没有事发生） */
  at: Date
  /** 连续多少轮无事发生；有事发生的那一轮是 0 */
  quietRounds: number
}

/**
 * 一轮聚合的结论（与 `TimelineReconcileResult` 对应，但这层不依赖服务层类型，
 * 避免 services/timeline → services/timeline-events 的循环引用）。
 */
export interface ReconcileRoundSummary {
  /** 订阅源总数 */
  sources: number
  /** 判出来要搬的源数 */
  dirty: number
  /** 退订清理掉的水位行数 */
  removedSyncs: number
  /** 退订清理掉的条目数 */
  removedEntries: number
  /** 清掉的遗留常驻复制任务数 */
  purgedReplications: number
  /** 本轮失败的源数 */
  failures: number
}

/** 这一轮是否"干了活"（决定进流水还是只更新心跳）—— 纯函数，便于单测 */
export function isReconcileRoundMeaningful(round: ReconcileRoundSummary): boolean {
  return round.dirty > 0
    || round.removedSyncs > 0
    || round.removedEntries > 0
    || round.purgedReplications > 0
    || round.failures > 0
}

/** 一轮汇聚的人话描述（给设置页的同步日志看） */
export function describeReconcileRound(round: ReconcileRoundSummary, ms: number): string {
  const parts: string[] = []
  if (round.dirty > 0) parts.push(`${round.dirty} 个源需搬运`)
  if (round.removedSyncs > 0 || round.removedEntries > 0) {
    parts.push(`退订清理 ${round.removedSyncs} 个源 / ${round.removedEntries} 条`)
  }
  if (round.purgedReplications > 0) parts.push(`清掉 ${round.purgedReplications} 条遗留常驻复制`)
  if (round.failures > 0) parts.push(`${round.failures} 个源失败`)
  const detail = parts.length > 0 ? parts.join("；") : "无需搬运"
  return `汇聚：订阅 ${round.sources} 个源，${detail}（${ms}ms）`
}

/** 合并后的描述：「连续 8 轮，共 15 个源需搬运」 */
function describeMergedRound(rounds: number, dirty: number, sources: number, failures: number): string {
  const parts = [`连续 ${rounds} 轮，共 ${dirty} 个源需搬运`]
  if (failures > 0) parts.push(`累计 ${failures} 个源失败`)
  return `汇聚：订阅 ${sources} 个源，${parts.join("；")}`
}

/** 记一条流水（旁路：内部吞异常） */
export async function recordTimelineEvent(input: {
  userId: string
  kind: TimelineEventKind
  message: string
  level?: TimelineEventLevel
  data?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(timelineEvents).values({
      userId: input.userId,
      kind: input.kind,
      level: input.level ?? "info",
      message: input.message,
      data: input.data ?? null,
    })
    // 裁剪只在低频事件上做（每源同步不写流水，所以一轮汇聚最多触发一次）
    if (input.kind === "reconcile" || input.kind === "rebuild") {
      await pruneTimelineEvents(input.userId)
    }
  } catch (err) {
    console.warn(`[Timeline] 写流水失败（不影响聚合）：${(err as Error)?.message ?? err}`)
  }
}

/**
 * 记一轮聚合：**先更新心跳**，只有"干了活"的轮次才写流水（窗口内并进上一条）。
 *
 * 心跳与流水分开，是因为读法不同：心跳永远只有最新一次（覆盖写），流水是历史。
 */
export async function recordReconcileRound(input: {
  userId: string
  round: ReconcileRoundSummary
  ms: number
}): Promise<void> {
  const { userId, round, ms } = input
  const meaningful = isReconcileRoundMeaningful(round)
  try {
    // ① 心跳：每轮都更新（空转 +1，有变化清零）
    const now = new Date()
    await db.insert(timelineReconcileHeartbeat)
      .values({ userId, at: now, quietRounds: meaningful ? 0 : 1 })
      .onConflictDoUpdate({
        target: timelineReconcileHeartbeat.userId,
        set: {
          at: now,
          quietRounds: meaningful
            ? 0
            : sql`${timelineReconcileHeartbeat.quietRounds} + 1`,
        },
      })
    if (!meaningful) return

    // ② 流水：能并进上一条就并，否则新起一条
    if (await mergeIntoPreviousReconcile(userId, round)) return
    await db.insert(timelineEvents).values({
      userId,
      kind: "reconcile",
      level: round.failures > 0 ? "warn" : "info",
      message: describeReconcileRound(round, ms),
      data: { ...round, rounds: 1, ms },
    })
    await pruneTimelineEvents(userId)
  } catch (err) {
    console.warn(`[Timeline] 写聚合流水失败（不影响聚合）：${(err as Error)?.message ?? err}`)
  }
}

/** 上一条 reconcile 还在合并窗口内 → 更新它（返回 true） */
async function mergeIntoPreviousReconcile(userId: string, round: ReconcileRoundSummary): Promise<boolean> {
  const [previous] = await db.select({
    id: timelineEvents.id,
    at: timelineEvents.at,
    data: timelineEvents.data,
  }).from(timelineEvents)
    .where(and(eq(timelineEvents.userId, userId), eq(timelineEvents.kind, "reconcile")))
    .orderBy(desc(timelineEvents.id))
    .limit(1)
  if (!previous) return false
  if (Date.now() - new Date(previous.at).getTime() > RECONCILE_MERGE_WINDOW_MS) return false

  const data = (previous.data ?? {}) as Partial<ReconcileRoundSummary> & { rounds?: number }
  const rounds = (data.rounds ?? 1) + 1
  const dirty = (data.dirty ?? 0) + round.dirty
  const removedSyncs = (data.removedSyncs ?? 0) + round.removedSyncs
  const removedEntries = (data.removedEntries ?? 0) + round.removedEntries
  const purgedReplications = (data.purgedReplications ?? 0) + round.purgedReplications
  const failures = (data.failures ?? 0) + round.failures
  await db.update(timelineEvents).set({
    // 时间取"最近一轮"；排序按 at 走，合并行会浮到最上面
    at: new Date(),
    level: failures > 0 ? "warn" : "info",
    message: describeMergedRound(rounds, dirty, round.sources, failures),
    data: {
      sources: round.sources,
      dirty,
      removedSyncs,
      removedEntries,
      purgedReplications,
      failures,
      rounds,
    },
  }).where(eq(timelineEvents.id, previous.id))
  return true
}

/** 只保留最近 N 条（一条 SQL：保留 id 在"最新 N 条"里的那些） */
async function pruneTimelineEvents(userId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM timeline_events
    WHERE user_id = ${userId}
      AND id NOT IN (
        SELECT id FROM timeline_events
        WHERE user_id = ${userId}
        ORDER BY id DESC
        LIMIT ${TIMELINE_EVENT_KEEP}
      )
  `)
}

/** 读流水（最新在前；合并行会更新 at，所以按 at 排而不是 id） */
export async function listTimelineEvents(userId: string, limit = 100): Promise<TimelineEventRow[]> {
  const rows = await db.select({
    id: timelineEvents.id,
    at: timelineEvents.at,
    kind: timelineEvents.kind,
    level: timelineEvents.level,
    message: timelineEvents.message,
    data: timelineEvents.data,
  }).from(timelineEvents)
    .where(eq(timelineEvents.userId, userId))
    .orderBy(desc(timelineEvents.at), desc(timelineEvents.id))
    .limit(limit)
  return rows
}

/** 读心跳（没有过任何一轮聚合时是 null） */
export async function readReconcileHeartbeat(userId: string): Promise<TimelineHeartbeat | null> {
  const [row] = await db.select({
    at: timelineReconcileHeartbeat.at,
    quietRounds: timelineReconcileHeartbeat.quietRounds,
  }).from(timelineReconcileHeartbeat)
    .where(eq(timelineReconcileHeartbeat.userId, userId))
    .limit(1)
  return row ?? null
}

/** 清空该用户的流水（设置页的「清空」；心跳不受影响） */
export async function clearTimelineEvents(userId: string): Promise<void> {
  await db.delete(timelineEvents).where(eq(timelineEvents.userId, userId))
}

/** 源级**当前状态**（不是流水） */
export interface TimelineSourceState {
  /** 源 id：feedId 或 `bot:{botId}` */
  sourceId: string
  kind: "feed" | "bot"
  /** 展示名（源标题 / bot 名）；查不到就是 null（源可能已被删） */
  title: string | null
  /** 上次同步**开始**的时刻；null = 还没同步成功过 */
  syncedAt: Date | null
  /** idle / syncing / error */
  status: string
  lastError: string | null
}

/**
 * 每个订阅源的当前同步状态（设置页「源状态」用）。
 *
 * 这部分**不落流水表** —— 它是状态不是事件：同一条信息每轮都会被覆盖，记成流水只会制造噪音。
 * 标题来自 `feeds` / `bots` 两张表（用户库里也有 FeedDoc 副本，但那是客户端可写的视图，不作权威）。
 */
export async function listTimelineSources(userId: string): Promise<TimelineSourceState[]> {
  const rows = await db.select({
    sourceId: timelineSourceSync.sourceId,
    syncedAt: timelineSourceSync.syncedAt,
    status: timelineSourceSync.status,
    lastError: timelineSourceSync.lastError,
  }).from(timelineSourceSync).where(eq(timelineSourceSync.userId, userId))

  const feedIds = rows.filter(row => !row.sourceId.startsWith("bot:")).map(row => row.sourceId)
  const botIds = rows.filter(row => row.sourceId.startsWith("bot:")).map(row => row.sourceId.slice("bot:".length))
  const titles = new Map<string, string>()
  if (feedIds.length > 0) {
    const found = await db.select({ id: feeds.id, title: feeds.title })
      .from(feeds).where(inArray(feeds.id, feedIds))
    for (const row of found) titles.set(row.id, row.title)
  }
  if (botIds.length > 0) {
    const found = await db.select({ id: botsTable.id, name: botsTable.name })
      .from(botsTable).where(inArray(botsTable.id, botIds))
    for (const row of found) titles.set(`bot:${row.id}`, row.name)
  }

  return rows
    .map(row => ({
      sourceId: row.sourceId,
      kind: (row.sourceId.startsWith("bot:") ? "bot" : "feed") as "feed" | "bot",
      title: titles.get(row.sourceId) ?? null,
      syncedAt: row.syncedAt,
      status: row.status,
      lastError: row.lastError,
    }))
    // 最近同步过的在前；从没同步过（syncedAt = null）的排后面
    .sort((a, b) => (b.syncedAt?.getTime() ?? 0) - (a.syncedAt?.getTime() ?? 0))
}

/** 仅用于测试/排查：该用户当前有多少条流水（裁剪逻辑的断言） */
export async function countTimelineEvents(userId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.userId, userId)))
  return row?.count ?? 0
}
