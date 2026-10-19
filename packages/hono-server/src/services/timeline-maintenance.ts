/**
 * 源库墓碑 GC（清理）与休眠用户暂停的**编排层**。
 *
 * 机制在 `couchdb/tombstone-gc.ts`（changes 扫描 / `_purge` / compact），
 * 安全判定在 `computeTombstoneCutoff`（时间窗，不用 seq —— purge 会重写序号）。
 *
 * 一轮 GC 对每个源做三件事：
 *   1. **补录**：从 `_local/tombstone-gc` 游标往后扫 `_changes`，把条目墓碑记进
 *      `timeline_source_tombstone`（历史墓碑在功能上线后第一次跑时补录）。
 *   2. **判定**：取该源所有**活跃**订阅者（休眠用户不算，他们回来会重建）的水位；
 *      没有任何活跃订阅者 → 全清；有订阅者还没成功同步过 → 本轮不动；
 *      否则只清 `first_seen_at < min(synced_at) - grace` 的墓碑。
 *   3. **清理**：分批 `_purge`，删掉 PG 待办行，清到了就 `_compact` 回收磁盘。
 *
 * 被"还没有成功同步过"挡住的源会**nudge**：把 `feeds.last_changed_at` 往前一拨，让下一轮
 * 聚合去同步一次（把删除投递到用户库），之后墓碑就可清了。节流见 `lastNudgeAt`。
 * 没有这一步，长期没有新内容的源会永远停在"订阅者水位早于墓碑"，历史墓碑清不掉。
 *
 * 为什么不用 seq 比较：CouchDB 的 purge 会重写 `_changes` 序号（同一行 purge 前后 token
 * 不同、甚至变小），拿 PG 里的 `source_seq` 和墓碑 seq 比大小会误判。时间窗只依赖
 * `synced_at`（复制开始时刻）与 `first_seen_at`（PG 时钟），两者同一时钟源。
 */
import { and, eq, inArray, sql } from "drizzle-orm"
import {
  COUCHDB_FEED_PREFIX,
  db,
  feeds,
  timelineSourceSync,
  timelineSourceTombstone,
  userTimelineSettings,
} from "../db"
import { envInt } from "../env"
import {
  chunkArray,
  computeTombstoneCutoff,
  createTombstoneGcStore,
  selectPurgeable,
  type SubscriberWatermark,
} from "../couchdb/tombstone-gc"

export interface TombstoneGcConfig {
  dryRun: boolean
  /** `_purge` 单请求条数 */
  batchSize: number
  /** 安全余量：只清早于 `min(订阅者 synced_at) - grace` 的墓碑 */
  graceMs: number
  /** 被挡住时 nudge 源 `lastChangedAt` 的最小间隔（0 = 不 nudge） */
  nudgeIntervalMs: number
  compact: boolean
  concurrency: number
  /** 单源单轮最多扫几页 changes（每页 scanLimit 条） */
  maxScanPages: number
  scanLimit: number
  /** 单源单轮最多处理多少条待清行（剩下的下一轮继续） */
  maxPendingRows: number
  /** 本轮最多处理几个源（undefined = 全部；脚本用） */
  maxSources?: number
}

export function readTombstoneGcConfig(overrides: Partial<TombstoneGcConfig> = {}): TombstoneGcConfig {
  return {
    dryRun: false,
    batchSize: envInt("TOMBSTONE_GC_BATCH", 200, { min: 1, max: 1000 }),
    graceMs: envInt("TOMBSTONE_GC_GRACE_MS", 120_000, { min: 0 }),
    nudgeIntervalMs: envInt("TOMBSTONE_GC_NUDGE_INTERVAL_MS", 1_800_000, { min: 0 }),
    compact: process.env.TOMBSTONE_GC_COMPACT !== "0",
    concurrency: envInt("TOMBSTONE_GC_CONCURRENCY", 2, { min: 1, max: 8 }),
    maxScanPages: envInt("TOMBSTONE_GC_MAX_SCAN_PAGES", 20, { min: 1, max: 500 }),
    scanLimit: envInt("TOMBSTONE_GC_SCAN_LIMIT", 500, { min: 50, max: 5000 }),
    maxPendingRows: envInt("TOMBSTONE_GC_MAX_PENDING_ROWS", 5000, { min: 100, max: 100_000 }),
    ...overrides,
  }
}

export interface TombstoneGcStats {
  dryRun: boolean
  /** 实际处理（扫过 changes）的源数 */
  sources: number
  /** 扫过的 changes 行数 */
  scannedChanges: number
  /** 新补录的墓碑数（dry-run 下是"会补录"） */
  recorded: number
  /** 是否"已经可以清"的墓碑数（本轮判定） */
  purgeable: number
  /** 真正 `_purge` 掉的墓碑数 */
  purged: number
  /** 触发 compact 的库数 */
  compacted: number
  /** 因订阅者水位不到位而本轮跳过的源数 */
  blockedSources: number
  /** nudge（bump 源 lastChangedAt）的次数 */
  nudged: number
  /** PG 里仍是待清状态的墓碑行数（本轮结束后重新数一遍，粗略） */
  pendingLeft: number
  errors: Array<{ sourceId: string, error: string }>
  elapsedMs: number
}

export interface TombstoneGcFeed {
  id: string
  couchDbName: string
  /** 源标题（只用于脚本报告；服务端内不读） */
  title: string | null
}

/** 列出要处理的 feed 源（GC 只处理 feed 库：bot 库不裁剪、不产生保留墓碑） */
export async function listTombstoneGcFeeds(): Promise<TombstoneGcFeed[]> {
  const rows = await db.select({ id: feeds.id, couchDbName: feeds.couchDbName, title: feeds.title })
    .from(feeds)
    .where(sql`${feeds.couchDbName} is not null and ${feeds.couchDbName} like ${`${COUCHDB_FEED_PREFIX}%`}`)
  return rows.flatMap((row) => (row.couchDbName
    ? [{ id: row.id, couchDbName: row.couchDbName, title: row.title ?? null }]
    : []))
}

/**
 * 该源的**活跃**订阅者水位。
 *
 * 休眠用户（`aggregation_paused_at is not null`）与等重建用户（`needs_rebuild`）不算：
 * 暂停期间他们不推进水位，但回来时会重建派生库 —— GC 清掉的墓碑对他们不是漏删，是"重算"。
 */
async function loadActiveSubscribers(sourceId: string): Promise<SubscriberWatermark[]> {
  const rows = await db.select({
    syncedAt: timelineSourceSync.syncedAt,
    status: timelineSourceSync.status,
    pausedAt: userTimelineSettings.aggregationPausedAt,
    needsRebuild: userTimelineSettings.needsRebuild,
  })
    .from(timelineSourceSync)
    .leftJoin(userTimelineSettings, eq(userTimelineSettings.userId, timelineSourceSync.userId))
    .where(eq(timelineSourceSync.sourceId, sourceId))
  return rows
    .filter((row) => row.pausedAt === null && row.needsRebuild !== true)
    .map((row) => ({ syncedAt: row.syncedAt, status: row.status }))
}

interface PendingTombstone {
  docId: string
  rev: string
  firstSeenAt: Date
}

async function loadPendingTombstones(sourceId: string, limit: number): Promise<PendingTombstone[]> {
  return db.select({
    docId: timelineSourceTombstone.docId,
    rev: timelineSourceTombstone.rev,
    firstSeenAt: timelineSourceTombstone.firstSeenAt,
  })
    .from(timelineSourceTombstone)
    .where(eq(timelineSourceTombstone.sourceId, sourceId))
    .limit(limit)
}

async function countPendingTombstones(sourceId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(timelineSourceTombstone)
    .where(eq(timelineSourceTombstone.sourceId, sourceId))
  return Number(row?.count ?? 0)
}

/** 补录墓碑（幂等：同一 (source, doc, rev) 只记一行、保留最早的 first_seen_at） */
async function recordTombstones(sourceId: string, candidates: Array<{ docId: string, rev: string }>): Promise<number> {
  if (candidates.length === 0) return 0
  const unique = new Map<string, { docId: string, rev: string }>()
  for (const candidate of candidates) unique.set(`${candidate.docId}\u0000${candidate.rev}`, candidate)
  const values = [...unique.values()].map((candidate) => ({
    sourceId,
    docId: candidate.docId,
    rev: candidate.rev,
  }))
  // 必须分批：一个重历史源首次补录可能一次扫出几万条，单条 INSERT 的参数个数会撞 Postgres
  // 的 65535 上限（3 列 × 3 万多 = 9.6 万，实测踩过，错误信息还会把整条 SQL 打进日志）。
  let inserted = 0
  for (const chunk of chunkArray(values, 500)) {
    const rows = await db.insert(timelineSourceTombstone)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ docId: timelineSourceTombstone.docId })
    inserted += rows.length
  }
  return inserted
}

/** 删掉已处理（清了 或 早就不存在）的待办行；按 (doc_id, rev) 复合删除，避免误删同 id 的新墓碑 */
async function deleteTombstoneRows(sourceId: string, rows: Array<{ docId: string, rev: string }>): Promise<void> {
  const tuples = rows.map((row) => sql`(${row.docId}, ${row.rev})`)
  await db.execute(sql`
    delete from timeline_source_tombstone
    where source_id = ${sourceId} and (doc_id, rev) in (${sql.join(tuples, sql`, `)})
  `)
}

async function deleteAllTombstoneRows(sourceId: string): Promise<void> {
  await db.delete(timelineSourceTombstone).where(eq(timelineSourceTombstone.sourceId, sourceId))
}

/** 让下一轮聚合把该源再同步一次（把删除投递给还没越过的订阅者） */
async function nudgeFeedChanged(sourceId: string): Promise<void> {
  await db.update(feeds).set({ lastChangedAt: new Date() }).where(eq(feeds.id, sourceId))
}

interface SourceGcResult {
  scannedChanges: number
  recorded: number
  purgeable: number
  purged: number
  compacted: number
  blocked: boolean
  nudged: boolean
  pendingLeft: number
}

/** 处理单个源；导出给脚本对单源做 dry-run / 实清 */
export async function runTombstoneGcForFeed(
  sourceId: string,
  couchDbName: string,
  config: TombstoneGcConfig,
  now: Date = new Date(),
): Promise<SourceGcResult> {
  const result: SourceGcResult = {
    scannedChanges: 0,
    recorded: 0,
    purgeable: 0,
    purged: 0,
    compacted: 0,
    blocked: false,
    nudged: false,
    pendingLeft: 0,
  }
  const store = createTombstoneGcStore(couchDbName)

  // ── 1) 从游标往后扫 changes，补录墓碑（dry-run 只数不写）─────────────────
  const checkpoint = await store.readCheckpoint()
  let since = checkpoint.changesSince
  const scannedCandidates: Array<{ docId: string, rev: string }> = []
  for (let page = 0; page < config.maxScanPages; page++) {
    const batch = await store.scanChanges(since, config.scanLimit)
    result.scannedChanges += batch.rows
    scannedCandidates.push(...batch.candidates)
    since = batch.nextSince
    if (!batch.hasMore) break
  }
  if (config.dryRun) {
    result.recorded = scannedCandidates.length
  } else {
    result.recorded = await recordTombstones(sourceId, scannedCandidates)
    if (since !== checkpoint.changesSince) {
      await store.writeCheckpoint({ ...checkpoint, changesSince: since })
    }
  }

  // ── 2) 判定水位 + 挑可清墓碑 ──────────────────────────────────────────
  const subscribers = await loadActiveSubscribers(sourceId)
  const cutoff = computeTombstoneCutoff(subscribers, config.graceMs)
  const pending = await loadPendingTombstones(sourceId, config.maxPendingRows)
  const existingPurgeable = selectPurgeable(pending, cutoff)
  result.purgeable = existingPurgeable.length
    + (config.dryRun && cutoff.mode === "all" ? scannedCandidates.length : 0)
  // "还有待办没清"就是被挡住：可能是订阅者还没同步到墓碑之后（时间窗），
  // 也可能是还有订阅者失败/没成功同步过（生命周期 blocked）。
  result.blocked = existingPurgeable.length < pending.length
    || (!config.dryRun && cutoff.mode === "blocked" && pending.length > 0)

  if (config.dryRun) {
    result.pendingLeft = await countPendingTombstones(sourceId)
    return result
  }

  // 库被外部清空过（doc_del_count = 0）：PG 待办行是残留，直接丢掉，避免永远卡在 blocked
  if (pending.length > 0 && await store.tombstoneCount() === 0) {
    await deleteAllTombstoneRows(sourceId)
    result.blocked = false
    result.pendingLeft = 0
    return result
  }

  // ── 3) 分批 purge + 删 PG 待办行 ──────────────────────────────────────
  for (const chunk of chunkArray(existingPurgeable, config.batchSize)) {
    const response = await store.purge(chunk.map((row) => ({ docId: row.docId, rev: row.rev })))
    result.purged += response.purged
    // 没被 purge 的（rev 已被后续修订覆盖 / 早已不存在）同样从待办里移除：
    // 它已经不是"需要传播的墓碑"，留着只会每轮重试。
    await deleteTombstoneRows(sourceId, chunk)
  }
  if (result.purged > 0 && config.compact) {
    await store.compact()
    result.compacted = 1
  }

  // ── 4) 还有没清的待办时 nudge，让订阅者再同步一次（越过墓碑时间点）──────
  // 这一步对"历史墓碑"和"持续新增的墓碑"都必要：GC 只能在本轮发现墓碑（first_seen_at=now），
  // 而订阅者最近一次成功同步通常早于 now —— 不让它同步一次，时间窗永远不成立，墓碑就永远等着。
  // 已就绪的源（可清数 = 待办数）不会 nudge；nudge 有节流（checkpoint.lastNudgeAt）。
  if (result.blocked && pending.length > 0 && subscribers.length > 0) {
    const lastNudgeAt = checkpoint.lastNudgeAt ? new Date(checkpoint.lastNudgeAt).getTime() : 0
    const nudgeDue = config.nudgeIntervalMs > 0 && now.getTime() - lastNudgeAt >= config.nudgeIntervalMs
    if (nudgeDue) {
      await nudgeFeedChanged(sourceId)
      await store.writeCheckpoint({
        ...checkpoint,
        changesSince: since,
        lastNudgeAt: now.toISOString(),
      })
      result.nudged = true
    }
  }

  result.pendingLeft = await countPendingTombstones(sourceId)
  return result
}

/**
 * 跑一轮 GC。默认处理全部 feed 源；`maxSources` 用于脚本/灰度。
 *
 * 不吞异常：单个源失败只记录并继续（一个卡住的库不能让整轮 GC 停摆）。
 */
export async function runTombstoneGc(
  config: TombstoneGcConfig = readTombstoneGcConfig(),
): Promise<TombstoneGcStats> {
  const startedAt = Date.now()
  const stats: TombstoneGcStats = {
    dryRun: config.dryRun,
    sources: 0,
    scannedChanges: 0,
    recorded: 0,
    purgeable: 0,
    purged: 0,
    compacted: 0,
    blockedSources: 0,
    nudged: 0,
    pendingLeft: 0,
    errors: [],
    elapsedMs: 0,
  }

  const allFeeds = await listTombstoneGcFeeds()
  const targets = config.maxSources && config.maxSources > 0 ? allFeeds.slice(0, config.maxSources) : allFeeds
  const now = new Date()

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const feed = targets[cursor++]!
      try {
        const source = await runTombstoneGcForFeed(feed.id, feed.couchDbName, config, now)
        stats.sources += 1
        stats.scannedChanges += source.scannedChanges
        stats.recorded += source.recorded
        stats.purgeable += source.purgeable
        stats.purged += source.purged
        stats.compacted += source.compacted
        stats.pendingLeft += source.pendingLeft
        if (source.blocked) stats.blockedSources += 1
        if (source.nudged) stats.nudged += 1
      } catch (err) {
        // 截断：PG 的参数超限错误会把整条 SQL 带进 message（几十 KB），日志会被冲爆
        const message = ((err as Error)?.message ?? String(err)).slice(0, 300)
        stats.errors.push({ sourceId: feed.id, error: message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker))
  stats.elapsedMs = Date.now() - startedAt
  return stats
}
