import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { db, feeds, user, botFeeds, siteSettings } from "../db"
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

/**
 * 环境变量给的**默认值**。运行时真正生效的值来自 `loadOrphanPolicy()`：
 * 管理员在「站点设置」里改过的值优先，没改过才回退到这里。
 *
 * 为什么允许在库里改：这几项直接决定"源什么时候被暂停/删除"，属于运营策略，
 * 不该每调一次都改 env 重启进程。
 */
const DEFAULT_PAUSE_AFTER_DAYS = envInt("FEED_ORPHAN_PAUSE_AFTER_DAYS", 7, { min: 0, max: 3650 })
const DEFAULT_DELETE_AFTER_DAYS = envInt("FEED_ORPHAN_DELETE_AFTER_DAYS", 30, { min: 0, max: 3650 })
const DEFAULT_BATCH_LIMIT = envInt("FEED_ORPHAN_BATCH_LIMIT", 500, { min: 1, max: 5000 })

/** 站点设置里存放该策略的 key（siteSettings.extras 是自由 jsonb，不必加新列） */
const POLICY_EXTRAS_KEY = "orphanPolicy"
/** 站点配置恒为单行，固定主键（与 routes/site-settings.ts 一致） */
const SITE_ID = "site"

/** 保证单例行存在；并发安全（onConflictDoNothing） */
async function ensureSiteSettingsRow(): Promise<void> {
  await db.insert(siteSettings).values({ id: SITE_ID }).onConflictDoNothing()
}

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

  // 运行时策略（站点设置优先、env 兜底）：管理员可能刚在设置里改过天数
  const policy = await loadOrphanPolicy()
  const { pauseAfterDays, deleteAfterDays, batchLimit } = policy

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
    .slice(0, batchLimit)
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

  const pauseCutoff = new Date(now.getTime() - pauseAfterDays * DAY_MS)
  const deleteCutoff = new Date(now.getTime() - deleteAfterDays * DAY_MS)

  // ③ 零订阅已持续超过冷静期、仍在抓的 → 暂停
  if (pauseAfterDays > 0) {
    const candidates = all.filter((f) => (
      !referenced.has(f.id)
      && f.status === "active"
      && f.orphanSince !== null
      && f.orphanSince <= pauseCutoff
    )).slice(0, batchLimit)
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
  if (deleteAfterDays > 0) {
    const doomed = all.filter((f) => (
      !referenced.has(f.id)
      && f.status === "paused"
      && f.pausedBySystem === true
      && f.orphanSince !== null
      && f.orphanSince <= deleteCutoff
    )).slice(0, batchLimit)

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

/** 生效中的孤儿源策略 */
export interface OrphanPolicy {
  pauseAfterDays: number
  deleteAfterDays: number
  batchLimit: number
  /** 两级都关时自动清理实际不工作 */
  enabled: boolean
  /** 这份值来自哪里：settings=管理员在站点设置里改过；env=环境变量默认值 */
  source: "settings" | "env"
}

/** 把未知输入规范成合法策略（非法值回退默认，不抛错 —— 存量数据可能不全） */
function normalizePolicy(raw: unknown): Omit<OrphanPolicy, "enabled" | "source"> {
  const src = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.max(min, Math.min(max, Math.floor(n)))
  }
  return {
    pauseAfterDays: num(src.pauseAfterDays, DEFAULT_PAUSE_AFTER_DAYS, 0, 3650),
    deleteAfterDays: num(src.deleteAfterDays, DEFAULT_DELETE_AFTER_DAYS, 0, 3650),
    // batchLimit 不允许配成 0：那会让自动清理永久不动
    batchLimit: num(src.batchLimit, DEFAULT_BATCH_LIMIT, 1, 5000),
  }
}

/**
 * 读取**当前生效**的策略：站点设置里存的优先，没有则用环境变量默认值。
 *
 * 读失败时回退默认值而不是抛错：调用方是定时任务，一次 PG 抖动不该让自动清理停摆
 * （用默认值最多是"按 env 那套跑"，行为仍可预期）。
 */
export async function loadOrphanPolicy(): Promise<OrphanPolicy> {
  let stored: unknown
  try {
    const [row] = await db
      .select({ extras: siteSettings.extras })
      .from(siteSettings)
      .where(eq(siteSettings.id, SITE_ID))
      .limit(1)
    stored = row?.extras?.[POLICY_EXTRAS_KEY]
  } catch {
    stored = undefined
  }
  const base = normalizePolicy(stored)
  return {
    ...base,
    enabled: base.pauseAfterDays > 0 || base.deleteAfterDays > 0,
    source: stored === undefined ? "env" : "settings",
  }
}

/**
 * 保存策略到站点设置（管理员操作）。
 *
 * 写进 `extras` 而不是加列：`extras` 就是"新配置字段暂写此处、避免频繁改表结构"用的
 * （见 db/schema.ts 该列注释）。只保留本 key，不动 extras 里其它内容。
 */
export async function saveOrphanPolicy(input: unknown): Promise<OrphanPolicy> {
  const next = normalizePolicy(input)
  await ensureSiteSettingsRow()
  const [existing] = await db
    .select({ extras: siteSettings.extras })
    .from(siteSettings)
    .where(eq(siteSettings.id, SITE_ID))
    .limit(1)
  const extras = { ...(existing?.extras ?? {}), [POLICY_EXTRAS_KEY]: next }
  await db.update(siteSettings).set({ extras }).where(eq(siteSettings.id, SITE_ID))
  return {
    ...next,
    enabled: next.pauseAfterDays > 0 || next.deleteAfterDays > 0,
    source: "settings",
  }
}
