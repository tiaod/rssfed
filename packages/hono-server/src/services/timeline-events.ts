import { and, desc, eq, sql } from "drizzle-orm"
import { db, timelineEvents, timelineReconcileHeartbeat } from "../db"

/**
 * 聚合流水：把"这一轮到底发生了什么"从服务端控制台搬到用户能看见的地方（设置页 → 同步日志）。
 *
 * 三条明确的设计取舍：
 *   1. **每一轮都记**（包括空转）。排查问题时"聚合跑了但没有要搬的"本身就是答案：能区分
 *      "没触发聚合"和"触发了但判定没变化"。空转轮次靠**汇聚冷却**（每用户 5 分钟最多一轮，
 *      见 workers/timeline 的 enqueueTimelineReconcile）压住频率，而不是靠不记。
 *   2. **窗口内连续轮次合并成一条**。冷却窗口内可能因为手动同步/强刷再跑一两轮，
 *      2 分钟内（`RECONCILE_MERGE_WINDOW_MS`）的同类轮次并成一条
 *      「连续 N 轮，共 M 个源需搬运 / 连续 N 轮无需搬运」。
 *   3. **只记离散动作，不记每个源**。源级"现在什么样"直接读 `timeline_source_sync`。
 *      另有一行 `timeline_reconcile_heartbeat` 作为概览用的心跳（最近一轮时刻 + 连续空转轮数）。
 *
 * 写流水是**旁路**：内部吞异常，日志写不进去绝不影响聚合本身。
 */

/** 每用户保留多少条流水（合并后一天也就几十条，2000 条 ≈ 一个月） */
export const TIMELINE_EVENT_KEEP = 2000

/**
 * 相邻两轮汇聚在这个窗口内合并成一条。
 *
 * 正常节奏被冷却限制在 5 分钟一轮，所以合并主要发生在"手动同步/强刷"造成的连发上；
 * 2 分钟足够把它们并掉，又不会把正常的定时轮次糊成一条。
 */
export const RECONCILE_MERGE_WINDOW_MS = 2 * 60_000

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
 * 一轮抓取的结论（给同步日志看）。
 *
 * 新模型下"一轮"= 调度器枚举所有 owner、把到期的源入队；没有复制、没有脏源判定，
 * 所以这里统计的是**抓取**的结果：多少个源到期、新增多少条、裁掉多少、失败多少。
 */
export interface FetchRoundSummary {
  /** 本轮检查的订阅源总数 */
  sources: number
  /** 判出来要抓的源数 */
  due: number
  /** 真正写进库的新条目数 */
  newEntries: number
  /** 裁掉的过期条目数 */
  trimmedEntries: number
  /** 本轮失败的源数 */
  failures: number
}

/** 这一轮是否"干了活"（决定进流水还是只更新心跳）—— 纯函数，便于单测 */
export function isRoundMeaningful(round: FetchRoundSummary): boolean {
  return round.due > 0 || round.newEntries > 0 || round.trimmedEntries > 0 || round.failures > 0
}

/** 兼容旧名（旧调用方仍在用）：同 isRoundMeaningful */
export const isReconcileRoundMeaningful = isRoundMeaningful

/** 一轮的人话描述（给设置页的同步日志看） */
export function describeRound(round: FetchRoundSummary, ms: number): string {
  const parts: string[] = []
  if (round.due > 0) parts.push(`${round.due} 个源到期`)
  if (round.newEntries > 0) parts.push(`新增 ${round.newEntries} 条`)
  if (round.trimmedEntries > 0) parts.push(`裁剪 ${round.trimmedEntries} 条`)
  if (round.failures > 0) parts.push(`${round.failures} 个源失败`)
  const detail = parts.length > 0 ? parts.join("；") : "无需抓取"
  return `抓取：订阅 ${round.sources} 个源，${detail}（${ms}ms）`
}

/** 合并后的描述：「连续 3 轮，共 15 个源到期」/「连续 5 轮无需抓取」 */
function describeMergedRound(rounds: number, due: number, sources: number, failures: number): string {
  const parts = [due > 0 ? `连续 ${rounds} 轮，共 ${due} 个源到期` : `连续 ${rounds} 轮无需抓取`]
  if (failures > 0) parts.push(`累计 ${failures} 个源失败`)
  return `抓取：订阅 ${sources} 个源，${parts.join("；")}`
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
 * 记一轮抓取：更新心跳 + 写一条流水（空转也写，合并窗口内并进上一条）。
 *
 * 心跳与流水分开，是因为读法不同：心跳永远只有最新一次（覆盖写），流水是历史。
 */
export async function recordFetchRound(input: {
  userId: string
  round: FetchRoundSummary
  ms: number
}): Promise<void> {
  const { userId, round, ms } = input
  const meaningful = isRoundMeaningful(round)
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
    // ② 流水：空转也记（排查时要能区分"没触发"和"触发了但没变化"）；能并进上一条就并
    if (await mergeIntoPreviousRound(userId, round)) return
    await db.insert(timelineEvents).values({
      userId,
      kind: "reconcile",
      level: round.failures > 0 ? "warn" : "info",
      message: describeRound(round, ms),
      data: { ...round, rounds: 1, ms },
    })
    await pruneTimelineEvents(userId)
  } catch (err) {
    console.warn(`[Timeline] 写抓取流水失败（不影响抓取）：${(err as Error)?.message ?? err}`)
  }
}

/** 兼容旧名 */
export const recordReconcileRound = recordFetchRound

/** 上一条还在合并窗口内 → 更新它（返回 true） */
async function mergeIntoPreviousRound(userId: string, round: FetchRoundSummary): Promise<boolean> {
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

  const data = (previous.data ?? {}) as Partial<FetchRoundSummary> & { rounds?: number }
  const rounds = (data.rounds ?? 1) + 1
  const due = (data.due ?? 0) + round.due
  const newEntries = (data.newEntries ?? 0) + round.newEntries
  const trimmedEntries = (data.trimmedEntries ?? 0) + round.trimmedEntries
  const failures = (data.failures ?? 0) + round.failures
  await db.update(timelineEvents).set({
    // 时间取"最近一轮"；排序按 at 走，合并行会浮到最上面
    at: new Date(),
    level: failures > 0 ? "warn" : "info",
    message: describeMergedRound(rounds, due, round.sources, failures),
    data: {
      sources: round.sources,
      due,
      newEntries,
      trimmedEntries,
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

/** 读心跳（没有过任何一轮时是 null） */
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

/** 仅用于测试/排查：该用户当前有多少条流水（裁剪逻辑的断言） */
export async function countTimelineEvents(userId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.userId, userId)))
  return row?.count ?? 0
}
