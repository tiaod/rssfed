/**
 * 源库裁剪：**每条源只保留最新 N 条**。
 *
 * 这是 `docs/notes/aggregation/source-side-retention-plan.md` 唯一的写入侧新模块。
 * 整个保留策略只有这一处权威：源库裁剪 → 删除跟着复制自然传播 → 用户库/浏览器是精确镜像。
 * 所以这里**没有窗口、没有 bound、没有 per-user 参数**，只有"第 N+1 条的发布时间"这一个下界。
 *
 * 三条实测前提（见方案文档 §9「本轮实测补充」）：
 * 1. 复制必须用 **filter function**（`probe-f`：删除会以 `_deleted` 变更跟着复制）。
 *    **不能用 Mango selector** —— selector 匹配不到墓碑，删除会静默丢失。
 * 2. 裁剪用**标准 delete**，不用 `_purge`（`probe-e`：purge 抹掉修订记忆后，一次全量重扫
 *    会把被删的条目从完整源库搬回来；delete 留墓碑则不会）。
 * 3. 删除只产生墓碑，附件字节要 `_compact` 才回收（`probe-a`）。
 *
 * 刻意的取舍：
 * - **并列时间戳不再是问题**：按视图行序（key, doc id 的全序）删最旧的 `total - N` 条，
 *   所以"最多 N 条"是真的最多（旧的下界方案遇到几百条同 time 的批量抓取会一条都删不掉）。
 * - **条数不够就不裁**（`total ≤ N`）：一条都不动。
 * - **`publishedAt` 乱序**：刚抓到但发布时间很老的条目会被立刻裁掉（方案 §5 风险 6，与旧行为一致）。
 */
import { createCouchDb } from "./client"

/** 每条源保留的条数（方案建议 50 = 旧 `minFeedEntries` 默认值，顺便解决低频源兜底） */
export const DEFAULT_SOURCE_RETENTION_ENTRIES = 50
/** 单批删除条数（首次裁剪要限速，见方案 §5 风险 1） */
export const DEFAULT_TRIM_BATCH = 200
/** 单次裁剪最多跑几批（剩下的下次抓取再删，避免一次删几千条） */
export const DEFAULT_TRIM_MAX_BATCHES = 10
/** 源库 view：`_design/main/entries-by-date`，key = publishedAt */
export const DEFAULT_TRIM_VIEW = "main/entries-by-date"

/**
 * 要删几条：`total - n`，负数按 0 算。纯函数，边界直接单测钉住。
 *
 * **为什么按条数而不是按"第 N+1 条的时间下界"**：下界方案（`publishedAt < bound`）在
 * **并列时间戳**面前会完全失效 —— 一次批量抓进来的几百条 `publishedAt` 一模一样时，
 * 下界等于它们自己，一条都删不掉（实测：一个库停在 467 条）。而视图的行序是
 * `(key, doc id)` 的**全序**，所以"按升序删掉最旧的 `total - n` 行"能精确收敛到 N 条，
 * 并列时保留 id 较大的那些（确定性，但不是按时间 —— 无副作用）。
 */
export function trimExcess(total: number, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`trimExcess: N 必须是正整数，收到 ${n}`)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.floor(total) - n)
}

export interface TrimResult {
  /** 视图里原本有多少条 */
  total: number
  /** 删掉的条数 */
  deleted: number
  /** 跑了几批 */
  batches: number
}

/** 裁剪只需要这几样能力；抽出来是为了单测注入假实现 */
export interface TrimDb {
  /** 视图里的总条数（CouchDB 的 `total_rows`，算出要删多少用） */
  countEntries(viewPath: string): Promise<number>
  /** 删掉**最旧的** `limit` 条（按视图升序），返回**成功**删掉的条数 */
  deleteOldest(viewPath: string, limit: number): Promise<number>
  /** 回收磁盘（附件与旧修订） */
  compact(): Promise<void>
}

/**
 * 每条源裁到最新 N 条。抓取 worker 写完新条目后调用一次即可。
 *
 * 做法：数出总条数 → 升序（最旧在前）分批删掉 `total - n` 条。删除批数有上限
 * （`maxBatches`）：首次上线时源库积着全部历史，一次删几千条会压出"删除风暴"（方案 §5 风险 1）。
 * 没删完的留给下一次抓取。
 */
export async function trimSourceToLatestN(
  db: TrimDb,
  opts: { n?: number, viewPath?: string, batchSize?: number, maxBatches?: number, compact?: boolean } = {},
): Promise<TrimResult> {
  const n = opts.n ?? DEFAULT_SOURCE_RETENTION_ENTRIES
  const viewPath = opts.viewPath ?? DEFAULT_TRIM_VIEW
  const batchSize = opts.batchSize ?? DEFAULT_TRIM_BATCH
  const maxBatches = opts.maxBatches ?? DEFAULT_TRIM_MAX_BATCHES

  const total = await db.countEntries(viewPath)
  let remaining = trimExcess(total, n)
  if (remaining === 0) return { total, deleted: 0, batches: 0 }

  let deleted = 0
  let batches = 0
  while (batches < maxBatches && remaining > 0) {
    const removed = await db.deleteOldest(viewPath, Math.min(batchSize, remaining))
    batches += 1
    deleted += removed
    remaining -= removed
    // 一批没删满说明删完了；一条都没删掉说明没有进展（并发冲突等），必须停
    if (removed < Math.min(batchSize, remaining + removed)) break
    if (removed === 0) break
  }
  if (opts.compact && deleted > 0) await db.compact()
  return { total, deleted, batches }
}

/** 真实实现：包一层 nano */
export function createTrimDb(dbName: string): TrimDb {
  const db = createCouchDb(dbName)
  const split = (viewPath: string): [string, string] => {
    const [design, view] = viewPath.split("/")
    if (!design || !view) throw new Error(`trim: 视图路径要形如 main/entries-by-date，收到 ${viewPath}`)
    return [design, view]
  }
  return {
    async countEntries(viewPath) {
      const [design, view] = split(viewPath)
      // limit=1 只为触发视图查询，`total_rows` 是索引里的总行数（与 limit 无关）
      const res = await db.view(design, view, { limit: 1, include_docs: false })
      return typeof res.total_rows === "number" ? res.total_rows : (res.rows?.length ?? 0)
    },
    async deleteOldest(viewPath, limit) {
      const [design, view] = split(viewPath)
      // 升序（最旧在前）取一批：删掉之后下一批自然接上，不需要游标
      const res = await db.view(design, view, { limit, include_docs: true })
      const docs = (res.rows ?? [])
        .map((row: { doc?: { _id?: string, _rev?: string } }) => row.doc)
        .filter((doc): doc is { _id: string, _rev: string } => Boolean(doc?._id && doc?._rev))
      if (docs.length === 0) return 0
      const results = await db.bulk({ docs: docs.map((doc) => ({ _id: doc._id, _rev: doc._rev, _deleted: true })) })
      // 只统计成功删掉的：并发的同 rev 删除会作为 conflict 返回，忽略即可（幂等，方案 §5 风险 8）
      return (results as Array<{ error?: string }>).filter((result) => !result.error).length
    },
    async compact() {
      await db.compact()
    },
  }
}
