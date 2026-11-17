import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { db, feeds, user, botFeeds } from "../db"
import { createCouchDb } from "../couchdb/client"
import { deleteFeed, type FeedSubscriber } from "./feed-deletion"
import { envInt } from "../env"

/**
 * 孤儿源的**全自动**分级清理（无需人工介入）。
 *
 * ## 三级状态机
 *
 * ```
 * 有人订阅 ──退订──▶ orphanSince=now（只标记，不动抓取）
 *                        │ 持续 ≥ PAUSE_AFTER
 *                        ▼
 *                   status=paused + pausedBySystem=true
 *                        │ 持续 ≥ DELETE_AFTER
 *                        ▼
 *                     删除（源库 + 条目 + 注册表行）
 * ```
 *
 * 每一级的门槛都是"**持续**了多久"，而不是"这一刻没人订阅"。原因：
 *   - 退订后马上又想订回来、多设备同步延迟、客户端离线同步未完成 —— 都表现为
 *     "此刻零订阅"。立即暂停会打断这些正常操作。
 *
 * ## 为什么需要 orphanSince 这一列
 *
 * 退订会删掉 `timeline_source_sync` 的水位行（见 services/timeline.ts 的退订清理），
 * 所以"最后一次订阅什么时候消失"在库里没有任何痕迹。没有这列就只能"发现零订阅就当孤儿"，
 * 那等于取消了冷静期。do
 *
 * ## 删除这一级为什么敢自动做
 *
 * 删除前有一道硬校验：**重新扫一遍订阅关系**，此刻仍有引用就放弃（并清掉 orphanSince）。
 * 也就是说"删除"这个不可逆动作永远建立在"刚刚亲眼确认过没人订阅"之上，
 * 而不是"相信几天前的判断"。
 *
 * ## 与手动入口的关系
 *
 * 手动入口（`POST /api/feeds/orphans/pause`）仍然保留，但默认不再"立即暂停"——
 * 它会走同一套冷静期。真正的紧急清理可以在界面上显式强删/单条删除。
 */

/** 多少天后"持续零订阅"才暂停抓取（0 = 关闭自动暂停） */
const PAUSE_AFTER_DAYS = envInt("FEED_ORPHAN_PAUSE_AFTER_DAYS", 7, { min: 0, max: 3650 })
/** 暂停后再过多少天仍零订阅就删除（0 = 永不删除） */
const DELETE_AFTER_DAYS = envInt("FEED_ORPHAN_DELETE_AFTER_DAYS", 30, { min: 0, max: 3650 })
/** 一轮扫描最多改动多少条（防止首次上线把所有积压源一次性全处理） */
const BATCH_LIMIT = envInt("FEED_ORPHAN_BATCH_LIMIT", 500, { min: 1, max: 5000 })

const DAY_MS = 86_400_000

/** 一轮自动清理的结果 */
export interface OrphanSweepResult {
  /** 本轮新标记为孤儿的源数（写 orphanSince） */
  marked: number
  /** 本轮因重新有人订阅而清掉孤儿标记的源数 */
  cleared: number
  /** 达到冷静期、本轮被暂停的源数 */
  paused: number
  /** 达到删除期、本轮被删除的源数 */
  deleted: number
  /** 跳过的（管理员手动暂停的、或删除前复核发现又有人订阅的） */
  skipped: number
  /** 是否因为订阅关系扫描不完整而整体跳过 */
  aborted: boolean
  reason?: string
}

/** 收集被订阅的 feedId（与 feed-orphans.scanOrphanFeeds 同口径，独立实现便于这里单测） */
async function referencedFeedIds(): Promise<{ ids: Set<string>, failures: number }> {
  const ids = new Set<string>()
  let failures = 0
  const users = await db.select({ id: user.id, dbName: user.timelineDbName }).from(user).catch(() => [])

  await Promise.all(users.map(async (u) => {
    if (!u.dbName) return
    try {
      const db2 = createCouchDb(u.dbName)
      const { rows } = await db2.list({
        startkey: "subscription:",
        endkey: "subscription:\uffff",
        include_docs: true,
      })
      for (const row of rows) {
        const doc = row.doc as { feedId?: unknown, kind?: unknown } | undefined
        const feedId = doc?.feedId
        if (typeof feedId === "string" && feedId.length > 0 && doc?.kind !== "bot") ids.add(feedId)
      }
    } catch {
      // 读不到就不能断言"里面没有订阅"，让调用方整体放弃本轮
      failures += 1
    }
  }))

  const botRefs = await db.selectDistinct({ feedId: botFeeds.feedId }).from(botFeeds).catch(() => [])
  for (const row of botRefs) ids.add(row.feedId)

  return { ids, failures }
}

/**
 * 跑一轮自动清理（三级状态机）。
 *
 * 任何"订阅关系看不清"的情况都**整体放弃本轮**：宁愿晚一天清理，也不能误删别人的源。
 */
export async function sweepOrphanFeeds(options: { now?: Date } = {}): Promise<OrphanSweepResult> {
  const now = options.now ?? new Date()
  const result: OrphanSweepResult = {
    marked: 0, cleared: 0, paused: 0, deleted: 0, skipped: 0, aborted: false,
  }

  const { ids: referenced, failures } = await referencedFeedIds()
  if (failures > 0) {
    return { ...result, aborted: true, reason: `有 ${failures} 个订阅库读取失败` }
  }

  const all = await db.select({
    id: feeds.id,
    status: feeds.status,
    pausedBySystem: feeds.pausedBySystem,
    orphanSince: feeds.orphanSince,
  }).from(feeds)

  // ① 有订阅者的：清掉孤儿标记（说明「又有人要了」）
  const toClear = all.filter((f) => referenced.has(f.id) && f.orphanSince !== null)
  if (toClear.length > 0) {
    const cleared = await db.update(feeds)
      .set({ orphanSince: null })
      .where(inArray(feeds.id, toClear.map((f) => f.id)))
      .returning({ id: feeds.id })
    result.cleared = cleared.length
  }

  // ② 零订阅且还没打过标记的：记录「从此刻开始没人要」
  const toMark = all
    .filter((f) => !referenced.has(f.id) && f.orphanSince === null)
    .slice(0, BATCH_LIMIT)
  if (toMark.length > 0) {
    const marked = await db.update(feeds)
      .set({ orphanSince: now })
      .where(and(
        inArray(feeds.id, toMark.map((f) => f.id)),
        isNull(feeds.orphanSince),
      ))
      .returning({ id: feeds.id })
    result.marked = marked.length
  }

  const pauseCutoff = new Date(now.getTime() - PAUSE_AFTER_DAYS * DAY_MS)
  const deleteCutoff = new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS)

  // ③ 零订阅已持续超过冷静期、仍在抓的 → 暂停
  if (PAUSE_AFTER_DAYS > 0) {
    const candidates = all.filter((f) => (
      !referenced.has(f.id)
      && f.status === "active"
      && f.orphanSince !== null
      && f.orphanSince <= pauseCutoff
    )).slice(0, BATCH_LIMIT)
    if (candidates.length > 0) {
      const paused = await db.update(feeds)
        .set({ status: "paused", pausedBySystem: true })
        .where(and(
          inArray(feeds.id, candidates.map((f) => f.id)),
          eq(feeds.status, "active"),
        ))
        .returning({ id: feeds.id })
      result.paused = paused.length
    }
  }

  // ④ 自动暂停后仍持续零订阅、超过删除期 → 删除
  //
  //    删除不可逆，所以**逐个复核**（不是信任几天的判断）：删除前再确认它此刻确实
  //    零订阅。复核成本是每源一次内存查找（referenced 集合是本轮刚扫的），不额外查库。
  if (DELETE_AFTER_DAYS > 0) {
    const doomed = all.filter((f) => (
      !referenced.has(f.id)
      && f.status === "paused"
      && f.pausedBySystem === true
      && f.orphanSince !== null
      && f.orphanSince <= deleteCutoff
    )).slice(0, BATCH_LIMIT)

    for (const feed of doomed) {
      try {
        // 删除前的最后一道：复核此刻仍无人订阅（本轮扫描结果）
        if (referenced.has(feed.id)) {
          result.skipped += 1
          continue
        }
        const subscribers: FeedSubscriber[] = []
        await deleteFeed(feed.id, subscribers)
        result.deleted += 1
      } catch (err) {
        // 单个失败不影响其余
        console.error(`[FeedOrphans] 删除源 ${feed.id} 失败：`, (err as Error)?.message ?? err)
        result.skipped += 1
      }
    }
  }

  // 管理员手动暂停的源不该被这一套接管：它们 pausedBySystem 为空，天然不在候选里
  result.skipped += all.filter((f) => f.status === "paused" && f.pausedBySystem !== true && f.orphanSince !== null).length

  return result
}

/** 供管理端展示的自动清理配置（前端据此说明"多久会发生什么"） */
export function orphanPolicy() {
  return {
    pauseAfterDays: PAUSE_AFTER_DAYS,
    deleteAfterDays: DELETE_AFTER_DAYS,
    batchLimit: BATCH_LIMIT,
    /** 两级都关时自动清理实际不工作 */
    enabled: PAUSE_AFTER_DAYS > 0 || DELETE_AFTER_DAYS > 0,
  }
}
