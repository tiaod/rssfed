import { eq, inArray, and } from "drizzle-orm"
import { db, feeds, user, botFeeds } from "../db"
import { createCouchDb } from "../couchdb/client"

/**
 * 孤儿源（零订阅）的统计与批量暂停/恢复。
 *
 * ## 为什么要做这件事
 *
 * 抓取调度器只按 `feeds.status = 'active'` 入队（见 workers/index.ts），**完全不看有没有
 * 人订阅**。于是任何被订阅过、后来全部退订的源会永久占用抓取配额：实测线上 707 条源里
 * 只有 133 个订阅关系覆盖 129 条源，**578 条（82%）是零订阅孤儿且全部在跑**。它们每轮
 * 都在打外网、写库、参与自适应调度，却没有任何人会看到结果。
 *
 * ## 为什么"暂停"而不是"删除"
 *
 * 删了就丢了 URL↔feedId 的注册关系，用户下次订阅同一地址会按 URL 哈希重新派生 ID ——
 * 虽然能重建，但历史条目、图片附件、条件请求验证器全都没了，且会重新走一遍全量首抓。
 * 暂停只是"不再抓"，注册表与源库都留着，有人订阅时恢复即可。
 *
 * ## 判定"零订阅"为什么不能只看水位表
 *
 * `timeline_source_sync` 的行是"那次同步自己 upsert 的"，并非订阅那一刻创建；休眠账号
 * （`aggregation_paused_at` 非空）在暂停期间照常能订阅，但聚合被跳过、永远不建行。
 * 所以判定必须回到权威来源：**枚举各用户库的 `subscription:` 文档**（理由与
 * feed-deletion.ts 的订阅者守卫相同）。
 *
 * 好消息是这可以**一次扫描回答全部源**，而不是逐源查：对每个用户库列一次
 * `subscription:` 前缀区间，收集被订阅的 feedId 集合，再与注册表求差。
 * 成本 = 用户库数量 × 1 次区间查询（实测每库单次 ~1.4ms，且与库大小无关）。
 *
 * ## 与"自动恢复"的配合
 *
 * 暂停时写 `pausedBySystem = true`，恢复只碰这类行 —— 管理员手动暂停的源不会被误恢复
 * （见 db/schema.ts 该列的注释）。
 */

/** 一次扫描的结果 */
export interface OrphanScanResult {
  /** 注册表里的源总数 */
  total: number
  /** 被至少一个用户/ Bot 引用的源数 */
  referenced: number
  /** 零订阅源（含已暂停的） */
  orphans: Array<{
    id: string
    url: string
    title: string
    status: string
    pausedBySystem: boolean | null
    lastFetchedAt: Date | null
  }>
  /** 孤儿源里当前还在抓的（真正的浪费） */
  activeOrphans: number
  /** 已由本功能暂停的 */
  alreadyPaused: number
  /** 判断过程中读用户库失败的次数（大于 0 时结果不可全信） */
  scanFailures: number
  /**
   * feedId → 零订阅起始时刻（未标记则为 null）。
   * 单独用 Map 而不是塞进 orphans 数组：手动暂停要按冷静期过滤，需要按 id 查。
   */
  orphansWithSince: Map<string, Date | null>
}

/**
 * 收集"被订阅的 feedId"集合。
 *
 * 同时算上 `bot_feeds`：Bot 可以引用一个 feed 而不产生任何 `subscription:` 文档，
 * 那种源不该被当成孤儿。
 */
async function collectReferencedFeedIds(users: Array<{ id: string, dbName: string | null }>): Promise<{
  ids: Set<string>
  failures: number
}> {
  const ids = new Set<string>()
  let failures = 0

  await Promise.all(users.map(async (u) => {
    if (!u.dbName) return
    try {
      const db = createCouchDb(u.dbName)
      const { rows } = await db.list({
        startkey: "subscription:",
        endkey: "subscription:\uffff",
        include_docs: true,
      })
      for (const row of rows) {
        const doc = row.doc as { feedId?: unknown, kind?: unknown } | undefined
        // 与 listSubscriptionSources 同规则：feedId 必须是非空字符串
        const feedId = doc?.feedId
        if (typeof feedId === "string" && feedId.length > 0 && doc?.kind !== "bot") {
          ids.add(feedId)
        }
      }
    } catch {
      // 读不到的库不能当成"里面没有订阅"——那会把它的订阅源误判成孤儿。记一次失败，
      // 由调用方决定是否整体拒绝执行（宁可少暂停，不可误暂停）。
      failures += 1
    }
  }))

  // Bot 引用的源同样算"有人关注"
  const botRefs = await db.selectDistinct({ feedId: botFeeds.feedId }).from(botFeeds)
  for (const row of botRefs) ids.add(row.feedId)

  return { ids, failures }
}

/** 扫描出所有零订阅源（只读，不写库） */
export async function scanOrphanFeeds(options: { limit?: number } = {}): Promise<OrphanScanResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 2000))
  const users = await db.select({ id: user.id, dbName: user.timelineDbName }).from(user).catch(() => [])
  const { ids: referencedIds, failures } = await collectReferencedFeedIds(users)

  const all = await db.select({
    id: feeds.id,
    url: feeds.url,
    title: feeds.title,
    status: feeds.status,
    pausedBySystem: feeds.pausedBySystem,
    orphanSince: feeds.orphanSince,
    lastFetchedAt: feeds.lastFetchedAt,
  }).from(feeds)

  const orphans = all.filter((f) => !referencedIds.has(f.id))
  // 排序：正在抓的排前面（那些才是真浪费），其次按最后抓取时间从旧到新
  orphans.sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1
    const bActive = b.status === "active" ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0)
  })

  return {
    total: all.length,
    referenced: all.length - orphans.length,
    orphans: orphans.slice(0, limit),
    activeOrphans: orphans.filter((f) => f.status === "active").length,
    alreadyPaused: orphans.filter((f) => f.pausedBySystem === true).length,
    scanFailures: failures,
    orphansWithSince: new Map(orphans.map((f) => [f.id, f.orphanSince ?? null])),
  }
}

/** 批量暂停结果 */
export interface PauseOrphansResult {
  /** 本次实际暂停的源数 */
  paused: number
  /** 被跳过的（已经是暂停态 / 期间被人订阅了） */
  skipped: number
  /** 因读用户库失败而整体拒绝时为 true（此时一个都没暂停） */
  aborted: boolean
  reason?: string
}

/**
 * 批量暂停零订阅源。
 *
 * 两道保护：
 *   1. **扫描有任何失败就整体不做**（`aborted`）—— 读不到某个用户库时无法确定它里面有没有
 *      订阅这些源，宁可这次少暂停，也不要把别人在看的源停掉。
 *   2. 只暂停**此刻仍然零订阅**的源：扫描与写入之间可能有人订阅，所以按本轮的
 *      referenced 集合再过滤一次（用的是同一次扫描结果，不是逐源复查 —— 逐源复查在
 *      578 个源 × N 个库的规模下太贵，而这一层保护针对的是"扫描结果已经过期"的极端情况，
 *      真正的即时性由订阅路径的自动恢复兜底）。
 */
export async function pauseOrphanFeeds(options: { limit?: number, ignoreGrace?: boolean } = {}): Promise<PauseOrphansResult> {
  const scan = await scanOrphanFeeds({ limit: options.limit ?? 2000 })

  if (scan.scanFailures > 0) {
    return {
      paused: 0,
      skipped: 0,
      aborted: true,
      reason: `有 ${scan.scanFailures} 个用户库读取失败，无法确认订阅关系，本次不执行`,
    }
  }

  // 默认**遵守冷静期**：只暂停"零订阅已持续 ≥ FEED_ORPHAN_PAUSE_AFTER_DAYS"的源。
  // 不这样做的话，手动入口会绕过自动机制的保护 —— 管理员点一下就把刚被退订 5 分钟的源停了。
  // 需要立刻处理时前端显式传 ignoreGrace（对应请求体 force: true）。
  let pool = scan.orphans
  if (!options.ignoreGrace) {
    const graceDays = Number(process.env.FEED_ORPHAN_PAUSE_AFTER_DAYS ?? 7)
    if (graceDays > 0) {
      const cutoff = Date.now() - graceDays * 86_400_000
      // 还没有 orphanSince 的源说明"本轮才第一次发现零订阅"，未满冷静期 → 不暂停
      const withSince = scan.orphansWithSince
      pool = scan.orphans.filter((f) => {
        const since = withSince.get(f.id)
        return since !== undefined && since !== null && since.getTime() <= cutoff
      })
    }
  }

  const candidates = pool.filter((f) => f.status !== "paused")
  if (candidates.length === 0) return { paused: 0, skipped: 0, aborted: false }

  const ids = candidates.map((f) => f.id)
  const updated = await db.update(feeds)
    .set({ status: "paused", pausedBySystem: true })
    .where(and(inArray(feeds.id, ids), eq(feeds.status, "active")))
    .returning({ id: feeds.id })

  return { paused: updated.length, skipped: candidates.length - updated.length, aborted: false }
}

/**
 * 某人刚订阅了某个源 → 若它是被本功能自动暂停的，立即恢复。
 *
 * 放在订阅路径上而不是只靠定时扫描：用户订阅后马上就能收到内容，不用等一个扫描周期。
 * 只动 `pausedBySystem = true` 的行 —— 管理员手动暂停的源不该因为有人订阅就自己开起来
 * （那会让"我明确停掉了它"这个意图失效）。
 *
 * @returns 是否真的恢复了
 */
export async function resumeIfAutoPaused(feedId: string): Promise<boolean> {
  const updated = await db.update(feeds)
    .set({ status: "active", pausedBySystem: null, errorMessage: null })
    .where(and(
      eq(feeds.id, feedId),
      eq(feeds.status, "paused"),
      eq(feeds.pausedBySystem, true),
    ))
    .returning({ id: feeds.id, url: feeds.url })
    .catch(() => [])

  if (updated.length === 0) return false
  // 恢复后要真的抓一次：该源可能已经停了几周，不能等下一个自适应调度周期
  const { enqueueFetch } = await import("../workers")
  const [row] = updated
  await enqueueFetch(row!.id, row!.url).catch(() => {})
  return true
}

/** 批量恢复所有被本功能暂停、但**现在确实有人订阅**的源（定时维护用） */
export async function resumeSubscribedAutoPaused(): Promise<number> {
  const users = await db.select({ id: user.id, dbName: user.timelineDbName }).from(user).catch(() => [])
  const { ids: referencedIds, failures } = await collectReferencedFeedIds(users)
  // 同样：看不清订阅关系时不动
  if (failures > 0) return 0

  const autoPaused = await db.select({ id: feeds.id, url: feeds.url })
    .from(feeds)
    .where(and(eq(feeds.status, "paused"), eq(feeds.pausedBySystem, true)))

  const toResume = autoPaused.filter((f) => referencedIds.has(f.id))
  if (toResume.length === 0) return 0

  const updated = await db.update(feeds)
    .set({ status: "active", pausedBySystem: null, errorMessage: null })
    .where(inArray(feeds.id, toResume.map((f) => f.id)))
    .returning({ id: feeds.id })

  const { enqueueFetch } = await import("../workers")
  await Promise.all(updated.map(async (row) => {
    const target = toResume.find((f) => f.id === row.id)
    if (target) await enqueueFetch(target.id, target.url).catch(() => {})
  }))
  return updated.length
}
