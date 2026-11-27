import { and, desc, eq, sql } from "drizzle-orm"
import { db, timelineEvents, timelineReconcileHeartbeat } from "../db"

/**
 * 抓取流水：把「服务端这一轮替你到底抓了什么」从控制台搬到用户能看见的地方（设置页 → 同步日志）。
 *
 * ## 新模型下「一轮」是什么
 *
 * 旧模型一轮 = 拓扑对齐 + 判定脏源 + 扇出复制。新模型没有复制也没有脏源：抓取按 owner
 * 各自进行、直接写进各自的库，所以一轮就是**调度器枚举所有 owner、把到期的源入队**，
 * 再由这一批 job 完成真正的抓取。`FetchRoundSummary` 记的就是这两步的合计。
 *
 * ## 三条明确的设计取舍
 *
 *   1. **空转也记**。排查问题时「跑了但没有要抓的」本身就是答案：能区分「没触发调度」和
 *      「触发了但所有源都没到期」。频率靠**结算节奏**（每 tick 一轮）与**合并窗口**压住，
 *      而不是靠不记。
 *   2. **窗口内连续轮次合并成一条**。调度 tick 之间可能因为重启或运维手动催再跑一两轮，
 *      2 分钟（`FETCH_ROUND_MERGE_WINDOW_MS`）内的同类轮次并成一条「连续 N 轮，共 M 个源到期」。
 *   3. **只记整轮，不记每个源**。几百个源各记一条会把流水刷爆（旧模型实测 4 小时 671 条）。
 *      源级「现在什么样」在**用户库自己的 `_local/schedule`** 里（客户端经订阅列表读到
 *      `lastFetchedAt` / `errorMessage`），不在这里重复一份。
 *
 * 写流水是**旁路**：内部吞异常，日志写不进去绝不影响抓取本身。
 */

/**
 * 每用户保留多少条流水。
 *
 * 一轮 tick 默认 15 分钟 → 一天 96 条，2000 条 ≈ 三周。合并窗口会把连发的轮次压成一条，
 * 实际留存更久。
 */
export const TIMELINE_EVENT_KEEP = 2000

/**
 * 相邻两轮抓取在这个窗口内合并成一条。
 *
 * 正常节奏由调度间隔（`FETCH_INTERVAL`，默认 15 分钟）决定，合并主要发生在进程重启后
 * 连续两次调度、或运维手动催的那一两轮上；2 分钟足够把它们并掉，又不会把正常的定时轮次糊成一条。
 */
export const FETCH_ROUND_MERGE_WINDOW_MS = 2 * 60_000

export interface TimelineEventRow {
  id: number
  at: Date
  /**
   * 流水类型。新模型只写 `fetch`（一轮抓取）。
   *
   * 旧模型写过的 `reconcile` / `rebuild` / `source-sync` / `error` 仍在库里，客户端按原标签
   * 显示（汇聚 / 重建 / 首搬 / 失败），但服务端不再产生 —— 没有派生库可重建、没有逐源搬运。
   * 所以这里是 `string` 而不是闭集：读到老行要能原样透出。
   */
  kind: string
  /** info / warn / error（同样是 string：老行不会有新取值，但也不该让读取侧崩掉） */
  level: string
  message: string
  /** 结构化补充（数字/源 id 等），客户端可以展开看 */
  data: unknown
}

export interface TimelineHeartbeat {
  /** 最近一轮抓取（不论有没有事发生） */
  at: Date
  /** 连续多少轮无事发生；有事发生的那一轮是 0 */
  quietRounds: number
}

/**
 * 一轮抓取的结论（给同步日志看）。
 *
 * 没有复制、没有脏源判定，所以统计的是**抓取**的结果：多少个源到期、新增多少条、
 * 裁掉多少、失败多少。`sources` / `due` 来自调度，其余三项由这一轮的 job 回填
 * （见 `workers/fetch-round.ts`）。
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

/** 这一轮是否"干了活"（决定心跳清零与否）—— 纯函数，便于单测 */
export function isRoundMeaningful(round: FetchRoundSummary): boolean {
  return round.due > 0 || round.newEntries > 0 || round.trimmedEntries > 0 || round.failures > 0
}

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

/**
 * 记一轮抓取：更新心跳 + 写一条流水（空转也写，合并窗口内并进上一条）。
 *
 * 心跳与流水分开，是因为读法不同：心跳永远只有最新一次（覆盖写），流水是历史。
 * 调用点在调度器结算上一轮时（见 `workers/index.ts` 的 `scheduleOwnerFetches`）。
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
      kind: "fetch",
      level: round.failures > 0 ? "warn" : "info",
      message: describeRound(round, ms),
      data: { ...round, rounds: 1, ms },
    })
    await pruneTimelineEvents(userId)
  } catch (err) {
    console.warn(`[Timeline] 写抓取流水失败（不影响抓取）：${(err as Error)?.message ?? err}`)
  }
}

/** 上一条还在合并窗口内 → 更新它（返回 true） */
async function mergeIntoPreviousRound(userId: string, round: FetchRoundSummary): Promise<boolean> {
  const [previous] = await db.select({
    id: timelineEvents.id,
    at: timelineEvents.at,
    data: timelineEvents.data,
  }).from(timelineEvents)
    .where(and(eq(timelineEvents.userId, userId), eq(timelineEvents.kind, "fetch")))
    .orderBy(desc(timelineEvents.id))
    .limit(1)
  if (!previous) return false
  if (Date.now() - new Date(previous.at).getTime() > FETCH_ROUND_MERGE_WINDOW_MS) return false

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
