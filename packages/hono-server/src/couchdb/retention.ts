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
 * - **拿不到下界就不裁**（视图行数 ≤ N、或第 N+1 行的 key 不是字符串）：宁可多留，不做不可逆的误删。
 * - **并列时间戳**：按"publishedAt < 下界"严格小于删除，所以并列的会一起留下 —— 保留策略满足
 *   "至少 N 条"即可（方案 §5 风险 7）。
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
 * 纯函数：从"按 `publishedAt` **降序**取的 key 列表"算出裁剪下界。
 * 返回 `undefined` = 不需要裁剪。
 *
 * `keys.length` 至少要是 `n + 1` 才能判断；正好 `n` 条就是不用裁。
 * 第 `n + 1` 行（下标 `n`）的 key 就是下界：`publishedAt < 下界` 的全删。
 */
export function trimBound(descendingKeys: readonly unknown[], n: number): string | undefined {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`trimBound: N 必须是正整数，收到 ${n}`)
  if (descendingKeys.length <= n) return undefined
  const bound = descendingKeys[n]
  if (typeof bound !== "string" || bound.length === 0) return undefined
  return bound
}

export interface TrimResult {
  /** 是否真的需要裁剪 */
  trimmed: boolean
  /** 裁剪下界（`publishedAt < bound` 的被删）；undefined = 没裁 */
  bound?: string
  /** 删掉的条数 */
  deleted: number
  /** 跑了几批 */
  batches: number
}

/** 裁剪只需要这几样能力；抽出来是为了单测注入假实现 */
export interface TrimDb {
  /** 按 `publishedAt` 降序取前 `limit` 行的 key */
  descendingKeys(viewPath: string, limit: number): Promise<unknown[]>
  /** 删除 `publishedAt < bound` 的条目（分页），返回**成功**删掉的条数 */
  deleteBelow(viewPath: string, bound: string, batchSize: number): Promise<number>
  /** 回收磁盘（附件与旧修订） */
  compact(): Promise<void>
}

/**
 * 每条源裁到最新 N 条。抓取 worker 写完新条目后调用一次即可。
 *
 * 删除批数有上限（`maxBatches`）：首次上线时源库积着全部历史，一次删几千条会压出"删除风暴"
 * （方案 §5 风险 1）。没删完的留给下一次抓取。
 */
export async function trimSourceToLatestN(
  db: TrimDb,
  opts: { n?: number, viewPath?: string, batchSize?: number, maxBatches?: number, compact?: boolean } = {},
): Promise<TrimResult> {
  const n = opts.n ?? DEFAULT_SOURCE_RETENTION_ENTRIES
  const viewPath = opts.viewPath ?? DEFAULT_TRIM_VIEW
  const batchSize = opts.batchSize ?? DEFAULT_TRIM_BATCH
  const maxBatches = opts.maxBatches ?? DEFAULT_TRIM_MAX_BATCHES

  // 只多取一行就够判断：第 N+1 行的 key 就是下界
  const bound = trimBound(await db.descendingKeys(viewPath, n + 1), n)
  if (bound === undefined) return { trimmed: false, deleted: 0, batches: 0 }

  let deleted = 0
  let batches = 0
  while (batches < maxBatches) {
    const removed = await db.deleteBelow(viewPath, bound, batchSize)
    batches += 1
    deleted += removed
    // 一批没删满说明已经删完；一批一条都没删掉说明没有进展（例如并发 conflict），必须停
    if (removed < batchSize) break
  }
  if (opts.compact && deleted > 0) await db.compact()
  return { trimmed: true, bound, deleted, batches }
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
    async descendingKeys(viewPath, limit) {
      const [design, view] = split(viewPath)
      const res = await db.view(design, view, { descending: true, limit, include_docs: false })
      return (res.rows ?? []).map((row: { key: unknown }) => row.key)
    },
    async deleteBelow(viewPath, bound, batchSize) {
      const [design, view] = split(viewPath)
      // 每次都从最低 key 取一批：删掉之后下一批自然接上，不需要游标
      const res = await db.view(design, view, { endkey: bound, inclusive_end: false, include_docs: true, limit: batchSize })
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
