/**
 * 时间窗口清理：**保留策略的唯一权威**。
 *
 * 设计依据与实测结论见 `docs/notes/aggregation/storage-refactor-plan.md`（§5 / §13）。
 * 三条必须成立的性质：
 *
 * 1. **窗口只有服务端算**：`retentionBoundIso()` 是唯一的边界来源，客户端不得用本机时钟现算。
 * 2. **源库直接 purge 活文档，不产生删除**（实测：201 成功、文档从 `_all_docs` 与 `_changes`
 *    同时消失、`_changes` 不留"取不到 rev"的行，复制器不会因此报错）。
 *    → 所以"先标准删除、再扫 `_changes` 找墓碑"两步是多余的。
 * 3. **冲突文档要把所有叶子一起 purge**：只 purge winner 时 loser 会顶上、文档仍然存在（实测）。
 *
 * 另一个刻意的取舍：**`publishedAt` 缺失或不是字符串的条目一律不清理**。
 * 日期缺失只让库大一点，误删是不可逆的（源库是内容的唯一来源）。
 *
 * 本模块是纯加法：只有被 worker 显式调用才会动数据，不改变任何现有行为。
 */
import { createCouchDb } from "./client"

/** 一次 `_purge` 请求里带的文档数 */
export const DEFAULT_PURGE_BATCH = 1000
/** 单次清理最多跑几页（限速用；剩下的留给下一轮） */
export const DEFAULT_MAX_PAGES = 50
/** 泳道之外的默认视图：源库 `_design/main` 里的 `entries-by-date`（key = publishedAt） */
export const DEFAULT_RETENTION_VIEW = "main/entries-by-date"

/** 视图行：`doc` 只在 `include_docs=true` 时有值 */
export interface RetentionRow {
  id: string
  doc?: { _rev?: string, _conflicts?: string[], publishedAt?: unknown } | null
}

/** 待清理的文档：`revs` 含冲突叶子（必须一起清，否则文档还在） */
export interface PurgeEntry {
  id: string
  revs: string[]
}

/** 墓碑账本里的一行（`deleted_at` 是我们做删除动作时记下的时刻） */
export interface TombstoneRecord {
  id: string
  rev: string
  deletedAt: string
}

export interface RetentionRun {
  /** 实际扫描的页数 */
  pages: number
  /** 真正被清掉的文档数 */
  docs: number
  /** 真正被清掉的 rev 数（含冲突叶子） */
  revs: number
  /** 请求了但没被清掉的 rev 数：已被清过、或 rev 已不是叶子 —— 探测 A 实测属正常，不是错误 */
  skipped: number
}

/**
 * retention 只需要 CouchDB 的这几样能力。抽成接口是为了单测能注入假实现，
 * 不去 mock 整个 nano（见 `__tests__/couchdb-retention.test.ts`）。
 */
export interface RetentionDb {
  /** 取「`publishedAt` 严格小于 bound」的前 `limit` 行（含 doc，好拿叶子 rev 与冲突叶子） */
  rowsBefore(viewPath: string, boundIso: string, limit: number): Promise<RetentionRow[]>
  /** `POST _purge`；返回真正被清掉的 rev（空数组 = 没清掉，正常） */
  purge(body: Record<string, string[]>): Promise<Record<string, string[]>>
  /** 批量删除（汇聚库用：**故意留墓碑**，好让客户端跟着缩水） */
  bulkDelete(docs: Array<{ _id: string, _rev: string, _deleted: true }>): Promise<void>
  /** `POST _compact`：purge/delete 之后回收磁盘（探针 A 实测 200KB 附件能被真正回收） */
  compact(): Promise<void>
}

/** 保留窗口下界：`now - days 天`。**服务端算一次**，全链路共用同一个值 */
export function retentionBoundIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

/**
 * 是否已过期。只有"能确定早于下界"的才返回 true：
 * 缺失、非字符串、无法比较的一律 false（宁可不删）。
 */
export function isExpiredDoc(publishedAt: unknown, boundIso: string): boolean {
  return typeof publishedAt === "string" && publishedAt.length > 0 && publishedAt < boundIso
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk: size 必须为正数")
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 视图行 → 待清理条目（同一 id 的多个分支合并；缺 rev 的行跳过） */
export function collectPurgeEntries(rows: readonly RetentionRow[]): PurgeEntry[] {
  const byId = new Map<string, Set<string>>()
  for (const row of rows) {
    const rev = row.doc?._rev
    if (!row.id || typeof rev !== "string" || rev.length === 0) continue
    const revs = byId.get(row.id) ?? new Set<string>()
    revs.add(rev)
    // 冲突分支也是叶子：只 purge winner 的话 loser 会顶上，文档仍然存在（探针 A 实测）
    for (const conflict of row.doc?._conflicts ?? []) {
      if (typeof conflict === "string" && conflict.length > 0) revs.add(conflict)
    }
    byId.set(row.id, revs)
  }
  return [...byId].map(([id, revs]) => ({ id, revs: [...revs] }))
}

/** 合并成一个 `_purge` 请求体 */
export function buildPurgeBody(entries: readonly PurgeEntry[]): Record<string, string[]> {
  const body: Record<string, string[]> = {}
  for (const entry of entries) body[entry.id] = [...entry.revs]
  return body
}

/** 统计"真正被清掉"的量。请求过但没清掉的（`purged[id]` 为空）计成 skipped，不是失败 */
export function summarizePurge(purged: Record<string, string[]> | undefined): { docs: number, revs: number, empty: number } {
  let docs = 0
  let revs = 0
  let empty = 0
  for (const revsOfId of Object.values(purged ?? {})) {
    if (Array.isArray(revsOfId) && revsOfId.length > 0) {
      docs += 1
      revs += revsOfId.length
    } else {
      empty += 1
    }
  }
  return { docs, revs, empty }
}

/** 墓碑账本里有资格被清的行：删除时刻**有效且**早于 `now - graceDays` */
export function selectPurgeableTombstones(rows: readonly TombstoneRecord[], now: Date, graceDays: number): TombstoneRecord[] {
  const bound = retentionBoundIso(now, graceDays)
  return rows.filter((row) => typeof row.deletedAt === "string" && row.deletedAt.length > 0 && row.deletedAt < bound)
}

/**
 * 源库/投影库的窗口清理：反复取「窗口外」的一页 → 直接 purge。
 *
 * 终止条件（任一）：
 *   - 这一页没有可清理的条目；
 *   - 这一页**一条都没真清掉**（没有进展，继续只会拿同一页无限循环 —— 例如全是非叶子 rev）；
 *   - 这一页不足一页（已经扫到尾）；
 *   - 达到 `maxBatches`（限速，剩下的下一轮再来）。
 */
export async function purgeExpired(
  db: RetentionDb,
  opts: { viewPath?: string, boundIso: string, batchSize?: number, maxBatches?: number },
): Promise<RetentionRun> {
  const viewPath = opts.viewPath ?? DEFAULT_RETENTION_VIEW
  const batchSize = opts.batchSize ?? DEFAULT_PURGE_BATCH
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_PAGES
  const run: RetentionRun = { pages: 0, docs: 0, revs: 0, skipped: 0 }
  while (run.pages < maxBatches) {
    const rows = await db.rowsBefore(viewPath, opts.boundIso, batchSize)
    const entries = collectPurgeEntries(rows.filter((row) => isExpiredDoc(row.doc?.publishedAt, opts.boundIso)))
    if (entries.length === 0) break
    const requested = entries.reduce((sum, entry) => sum + entry.revs.length, 0)
    const purged = await db.purge(buildPurgeBody(entries))
    const summary = summarizePurge(purged)
    run.pages += 1
    run.docs += summary.docs
    run.revs += summary.revs
    run.skipped += requested - summary.revs
    if (summary.revs === 0) break
    if (rows.length < batchSize) break
  }
  return run
}

/**
 * 汇聚库的过期清理：**故意用 delete（留墓碑）而不是 purge**。
 * 墓碑是"这条内容过期了"投递给客户端的唯一渠道（客户端不带 selector 拉取，会跟着删本地副本）。
 * 墓碑本身由 `pending_purge` 账本在宽限期之后清掉（见 `purgeTombstones`）。
 */
export async function deleteExpired(
  db: RetentionDb,
  opts: { viewPath?: string, boundIso: string, batchSize?: number, maxBatches?: number },
): Promise<RetentionRun> {
  const viewPath = opts.viewPath ?? DEFAULT_RETENTION_VIEW
  const batchSize = opts.batchSize ?? DEFAULT_PURGE_BATCH
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_PAGES
  const run: RetentionRun = { pages: 0, docs: 0, revs: 0, skipped: 0 }
  while (run.pages < maxBatches) {
    const rows = await db.rowsBefore(viewPath, opts.boundIso, batchSize)
    const entries = collectPurgeEntries(rows.filter((row) => isExpiredDoc(row.doc?.publishedAt, opts.boundIso)))
    if (entries.length === 0) break
    // 只删 winner：聚合条目的冲突极罕见（复制用 new_edits:false 写入），出现了由 LWW 裁决处理
    const docs = entries.map((entry) => ({ _id: entry.id, _rev: entry.revs[0]!, _deleted: true as const }))
    await db.bulkDelete(docs)
    run.pages += 1
    run.docs += docs.length
    run.revs += docs.length
    run.skipped += entries.reduce((sum, entry) => sum + entry.revs.length, 0) - docs.length
    if (rows.length < batchSize) break
  }
  return run
}

/** 墓碑账本的清理：按宽限期挑出可清的，分批 purge + compact */
export async function purgeTombstones(
  db: RetentionDb,
  rows: readonly TombstoneRecord[],
  opts: { now: Date, graceDays: number, batchSize?: number, compact?: boolean },
): Promise<RetentionRun> {
  const batchSize = opts.batchSize ?? DEFAULT_PURGE_BATCH
  const run: RetentionRun = { pages: 0, docs: 0, revs: 0, skipped: 0 }
  const due = selectPurgeableTombstones(rows, opts.now, opts.graceDays)
  for (const batch of chunk(due, batchSize)) {
    const requested = batch.length
    const purged = await db.purge(Object.fromEntries(batch.map((row) => [row.id, [row.rev]])))
    const summary = summarizePurge(purged)
    run.pages += 1
    run.docs += summary.docs
    run.revs += summary.revs
    run.skipped += requested - summary.revs
  }
  if (opts.compact && run.revs > 0) await db.compact()
  return run
}

/** 真实实现：包一层 nano。`_purge` 没被 nano 封装，走 `db.request`；它需要 admin 权限 */
export function createRetentionDb(dbName: string): RetentionDb {
  const db = createCouchDb(dbName) as ReturnType<typeof createCouchDb> & {
    request: (opts: { path: string, method: string, body?: unknown }) => Promise<unknown>
  }
  return {
    async rowsBefore(viewPath, boundIso, limit) {
      const [design, view] = viewPath.split("/")
      if (!design || !view) throw new Error(`retention: 视图路径要形如 main/entries-by-date，收到 ${viewPath}`)
      // 窗口外的条目在视图的**低端**：endkey = 下界（不含），从最小发布时间往后取一页
      const res = await db.view(design, view, { endkey: boundIso, inclusive_end: false, limit, include_docs: true })
      return (res.rows ?? []).map((row: { id: string, doc?: unknown }) => ({ id: row.id, doc: row.doc as RetentionRow["doc"] }))
    },
    async purge(body) {
      const res = (await db.request({ path: "_purge", method: "POST", body })) as { purged?: Record<string, string[]> }
      return res?.purged ?? {}
    },
    async bulkDelete(docs) {
      await db.bulk({ docs } as never)
    },
    async compact() {
      await db.compact()
    },
  }
}
