import { and, desc, eq, inArray, sql } from "drizzle-orm"
import {
  bots as botsTable,
  db,
  feeds,
  timelineEvents,
  timelineSourceSync,
} from "../db"

/**
 * 聚合流水：把"这一轮到底发生了什么"从服务端控制台搬到用户能看见的地方（设置页 → 同步日志）。
 *
 * 两条明确的设计取舍：
 *   1. **只记离散动作，不记每个源**。一轮汇聚可能有 100+ 个源入队，逐个记会把流水刷爆、也把
 *      同步给客户端的体积放大。源级别的"现在是什么状态"直接读 `timeline_source_sync`
 *      （它本来就是每源一行），见 `listTimelineSources`。这里只记：一轮汇聚的结论、重建、
 *      首搬、失败。
 *   2. **写失败绝不影响聚合**。日志是旁路：`recordTimelineEvent` 内部吞掉所有异常。
 *
 * 每用户只留最近 `TIMELINE_EVENT_KEEP` 条，裁剪跟着低频事件（汇聚/重建）一起做。
 */

/**
 * 每用户保留多少条流水。
 *
 * 一轮汇聚（定时器 5 分钟）记一条，即使全是空转也要记（用户就是想确认定时器还在跑）；
 * 2000 条 ≈ 一周的常规流水，够排查"昨天/前天怎么没动"。行很小（百来字节），不用担心体积。
 */
export const TIMELINE_EVENT_KEEP = 2000

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

/** 读流水（最新在前） */
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
    .orderBy(desc(timelineEvents.id))
    .limit(limit)
  return rows
}

/** 清空该用户的流水（设置页的「清空」） */
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
