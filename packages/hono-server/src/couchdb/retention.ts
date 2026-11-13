/**
 * 库裁剪：**每条源只保留最新 N 条**，用 `_purge` 而不是标准 delete。
 *
 * 这里是保留策略的**唯一实现**。源库（整库裁）与汇聚库（逐源裁）都调 `trimSourceToLatestN`，
 * 只是参数不同 —— 两侧各自独立执行，**不靠删除传播**（汇聚用 Mango selector，只搬活文档，
 * 所以删除根本进不了复制）。
 *
 * 为什么是 `_purge` 而不是 delete、为什么两侧必须各裁一遍：取舍与实测数据见
 * `ARCHITECTURE.md` 的「保留策略」一条，这里不重复。**改这条策略前先读那一节。**
 *
 * ## 三条仍然成立的边界
 *
 * 1. **`_purge` 不留墓碑**：清完该 id 在 `_all_docs?keys=` 里返回 `not_found`（**不是**
 *    tombstone），抓取 worker 的 `partitionByExistence` 会把它当成"从未出现"。抓取路径靠
 *    `workers/entry-selection.ts` 的 `selectNewestItems` 挡住复活（写库前先按 publishedAt
 *    截到最新 N 条，被 purge 的老条目进不了候选，实测零复活）；只有把 N 调大时会"恢复历史"。
 * 2. **并列时间戳**：按视图行序（key, doc id 的全序）删最旧的 `total - N` 条，所以"最多 N 条"
 *    是真的最多（下界方案遇到几百条同 time 的批量抓取会一条都删不掉，实测停在 467 条）。
 *    但并列时保留的是 **id 较大**的那些，而抓取侧 `selectNewestItems` 并列时保持 **feed 原有
 *    顺序** —— 两者不是同一个全序。N 不变时无所谓；一旦并列组跨过 N 的边界，就会出现"抓取窗口
 *    与裁剪窗口各留一批"，下一轮按 `not_found` 把另一批写回、再被 purge，形成每轮固定条数的
 *    写回+删除（实测 N=10 时每轮 1 条；全并列时每轮 8 条）。源库稳定停在 N 条、不影响正确性，
 *    但是一份常态写放大。
 * 3. **`publishedAt` 乱序**：刚抓到但发布时间很老的条目会被立刻裁掉（与旧行为一致）。
 *
 * 磁盘：purge 后 `doc_del_count` 立刻下降，但文件字节要 `_compact` 才回落（实测清理 879 个
 * 墓碑 + compact 后文件 12.0MB → 12.2MB，**几乎不降**）。所以清理的收益是**同步量**而不是磁盘，
 * 压缩按 CouchDB 自己的 smoosh 节奏走，这里只提供 `compact()` 给显式调用方。
 */
import { createCouchDb } from "./client"

/** 每条源保留的条数（方案建议 50 = 旧 `minFeedEntries` 默认值，顺便解决低频源兜底） */
export const DEFAULT_SOURCE_RETENTION_ENTRIES = 50
/** 单批清理条数（首次裁剪要限速，见方案 §5 风险 1） */
export const DEFAULT_TRIM_BATCH = 200
/** 单次裁剪最多跑几批（剩下的下次抓取再删，避免一次删几千条） */
export const DEFAULT_TRIM_MAX_BATCHES = 10
/** 源库 view：`_design/main/entries-by-date`，key = publishedAt */
export const DEFAULT_TRIM_VIEW = "main/entries-by-date"
/**
 * 汇聚库（`user-timeline_*`）用的 view：`_design/timeline-maintain/by-feed-date`。
 *
 * 用户库里的条目来自多个源，裁剪要**按源分组**各留 N 条（不是全库留 N 条）。
 * 这个视图是后加的，存量库由 `ensureTimelineDesignDoc` 补装（进程内按库名缓存）。
 */
export const USER_TIMELINE_TRIM_VIEW = "timeline-maintain/by-feed-date"
/** 汇聚库逐源裁剪时每次从视图读多少行（一页里按 feedId 分组处理） */
const PER_FEED_TRIM_PAGE = 5_000

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
  /** 清掉的条数 */
  deleted: number
  /** 跑了几批 */
  batches: number
}

/** 裁剪只需要这几样能力；抽出来是为了单测注入假实现 */
export interface TrimDb {
  /** 视图里的总条数（CouchDB 的 `total_rows`，算出要清多少用） */
  countEntries(viewPath: string): Promise<number>
  /** 清掉**最旧的** `limit` 条（按视图升序），返回**成功**清掉的条数 */
  purgeOldest(viewPath: string, limit: number): Promise<number>
  /** 回收磁盘（附件与旧修订） */
  compact(): Promise<void>
  /**
   * 按分组清掉每组超出 N 的旧条目（**只有汇聚库需要**：它一个库里装着多个源）。
   *
   * 源库一个库只有一个 feed，用 `purgeOldest` 就够；用户库要逐源各留 N 条。
   * 返回实际清掉的条数。
   */
  purgeExcessPerGroup?(viewPath: string, n: number, batchSize: number, maxBatches: number): Promise<{
    deleted: number
    batches: number
    total: number
  }>
}

/**
 * 每条源裁到最新 N 条（源库与汇聚库共用这一份实现）。抓取 worker 写完新条目后、
 * reconcile 每轮各调用一次。
 *
 * 做法：数出总条数 → 升序（最旧在前）分批清掉 `total - n` 条。批数有上限
 * （`maxBatches`）：首次上线时库里积着全部历史，一次清几千条会压出"清理风暴"（方案 §5 风险 1）。
 * 没清完的留给下一次。
 *
 * @param opts.groupByFeed 为 true 时按 `feedId` 分组各留 N 条（汇聚库），否则整库留 N 条（源库）
 */
export async function trimSourceToLatestN(
  db: TrimDb,
  opts: {
    n?: number
    viewPath?: string
    batchSize?: number
    maxBatches?: number
    compact?: boolean
    /** 汇聚库：一个库里装着多个源，要**逐源**各留 N 条 */
    groupByFeed?: boolean
  } = {},
): Promise<TrimResult> {
  const n = opts.n ?? DEFAULT_SOURCE_RETENTION_ENTRIES
  const viewPath = opts.viewPath ?? DEFAULT_TRIM_VIEW
  const batchSize = opts.batchSize ?? DEFAULT_TRIM_BATCH
  const maxBatches = opts.maxBatches ?? DEFAULT_TRIM_MAX_BATCHES

  // 汇聚库：多源同库 → 逐组裁（CouchDB 的视图行序天然按 group 分块，一次遍历即可）
  if (opts.groupByFeed) {
    if (!db.purgeExcessPerGroup) throw new Error("trim: groupByFeed 需要 TrimDb.purgeExcessPerGroup")
    const result = await db.purgeExcessPerGroup(viewPath, n, batchSize, maxBatches)
    if (opts.compact && result.deleted > 0) await db.compact()
    return { total: result.total, deleted: result.deleted, batches: result.batches }
  }

  const total = await db.countEntries(viewPath)
  let remaining = trimExcess(total, n)
  if (remaining === 0) return { total, deleted: 0, batches: 0 }

  let deleted = 0
  let batches = 0
  while (batches < maxBatches && remaining > 0) {
    const removed = await db.purgeOldest(viewPath, Math.min(batchSize, remaining))
    batches += 1
    deleted += removed
    remaining -= removed
    // 一批没清满说明清完了；一条都没清掉说明没有进展（并发冲突等），必须停
    if (removed < Math.min(batchSize, remaining + removed)) break
    if (removed === 0) break
  }
  if (opts.compact && deleted > 0) await db.compact()
  return { total, deleted, batches }
}

/**
 * `POST /<db>/_purge` 的请求体格式：`{"<docid>": ["<rev>", ...]}`（**旧格式**）。
 *
 * CouchDB 3.5 对新的 `docids` 格式报 `Invalid rev format`（实测）。响应
 * `{purged: {id: [revs]}}`；rev 不存在（已被别处清掉）时该 id 返回空数组 —— 幂等，
 * 可以当成"已经没有这条了"。
 */
export type PurgeBody = Record<string, string[]>

/** 把一批 `{id, rev}` 转成 `_purge` 请求体（同 id 的多个 rev 合并） */
export function buildPurgeBody(docs: Array<{ _id: string, _rev: string }>): PurgeBody {
  const body: PurgeBody = {}
  for (const doc of docs) (body[doc._id] ??= []).push(doc._rev)
  return body
}

/** 从 `_purge` 响应里数出真正清掉的 rev 数（rev 已不存在时返回空数组，不计） */
export function countPurged(purged: Record<string, string[]> | undefined, requested: PurgeBody): number {
  let total = 0
  for (const [id, revs] of Object.entries(requested)) {
    const done = purged?.[id]
    if (!Array.isArray(done)) continue
    for (const rev of revs) if (done.includes(rev)) total += 1
  }
  return total
}

/** 真实实现：包一层 nano */
export function createTrimDb(dbName: string): TrimDb {
  const db = createCouchDb(dbName)
  const split = (viewPath: string): [string, string] => {
    const [design, view] = viewPath.split("/")
    if (!design || !view) throw new Error(`trim: 视图路径要形如 main/entries-by-date，收到 ${viewPath}`)
    return [design, view]
  }

  /** 调 `_purge`，返回真正清掉的 rev 数 */
  const purgeDocs = async (docs: Array<{ _id: string, _rev: string }>): Promise<number> => {
    if (docs.length === 0) return 0
    const body = buildPurgeBody(docs)
    const res = await purgeRequest(dbName, body)
    return countPurged(res, body)
  }

  return {
    async countEntries(viewPath) {
      const [design, view] = split(viewPath)
      // limit=1 只为触发视图查询，`total_rows` 是索引里的总行数（与 limit 无关）
      const res = await db.view(design, view, { limit: 1, include_docs: false })
      return typeof res.total_rows === "number" ? res.total_rows : (res.rows?.length ?? 0)
    },
    async purgeOldest(viewPath, limit) {
      const [design, view] = split(viewPath)
      // 升序（最旧在前）取一批：清掉之后下一批自然接上，不需要游标
      const res = await db.view(design, view, { limit, include_docs: true })
      const docs = (res.rows ?? [])
        .map((row: { doc?: { _id?: string, _rev?: string } }) => row.doc)
        .filter((doc): doc is { _id: string, _rev: string } => Boolean(doc?._id && doc?._rev))
      return purgeDocs(docs)
    },
    async purgeExcessPerGroup(viewPath, n, batchSize, maxBatches) {
      const [design, view] = split(viewPath)
      // 视图 key 是 `[feedId, publishedAt]`，行序按源分块、组内按发布时间升序。
      //
      // 做法是**逐源整组读**（`startkey=[feed,""]` / `endkey=[feed,{}]`），而不是"翻页后
      // 按页内分组"：分页会把某个源切在两页之间，那一页只看得到半截数据 —— 按半截裁会
      // 误删本该保留的条目（少留不可逆），而"跳过等下一轮"又永远轮不到它（实测 25 条
      // 要裁到 5 条时，跳过写法每轮都删 0 条，永不收敛）。
      //
      // 单源一整组有多少行？受源库裁剪约束（≤ N，实测最大 50 档），所以整组读进内存是安全的；
      // `limit` 仍给个上限兜住异常大的库，超了就下一轮继续（视图行序稳定，会从同一位置接上）。
      let total = 0
      let deleted = 0
      let batches = 0
      /** 已处理到哪个源之后（用 endkey 推进，避免重复处理同一个源） */
      let nextFeedAfter: string | undefined

      for (;;) {
        if (batches >= maxBatches) break
        // 先取"下一个源 id"：视图降序取一条就是当前最小的未处理源
        const head = await db.view(design, view, {
          include_docs: false,
          limit: 1,
          ...(nextFeedAfter !== undefined
            ? { startkey: [nextFeedAfter, {}] }
            : {}),
        }) as unknown as { rows?: Array<{ key?: unknown }> }
        const headKey = head.rows?.[0]?.key
        if (!Array.isArray(headKey)) break
        const feedId = String((headKey as unknown[])[0])

        // 读这个源的**整组**（从 [feed,""] 到 [feed,{}]，即该源全部条目）
        const groupPage = await db.view(design, view, {
          include_docs: true,
          startkey: [feedId, ""],
          endkey: [feedId, {}],
          limit: PER_FEED_TRIM_PAGE,
        }) as unknown as { rows?: Array<{ key?: unknown, id?: string, doc?: { _id?: string, _rev?: string } }> }
        const groupRows = groupPage.rows ?? []
        const docs = groupRows
          .map(row => row.doc)
          .filter((doc): doc is { _id: string, _rev: string } => Boolean(doc?._id && doc?._rev))

        // 行数已到页上限说明这个源可能异常大（远超 N），只处理到"留最后 n 条"为止
        const excess = docs.slice(0, Math.max(0, docs.length - n))
        for (let i = 0; i < excess.length; i += batchSize) {
          if (batches >= maxBatches) break
          deleted += await purgeDocs(excess.slice(i, i + batchSize))
          batches += 1
        }
        total += docs.length
        if (batches >= maxBatches) break
        // 处理完这个源：下一轮从它之后开始（`{}` 排在所有 publishedAt 之后）
        nextFeedAfter = feedId
      }
      return { total, deleted, batches }
    },
    async compact() {
      await db.compact()
    },
  }
}

/**
 * 直接发 `_purge`（admin 连接）。抽成独立函数是因为两个调用方（源库裁剪、汇聚库裁剪、
 * 退订清理）都要用，而 nano 的 `request` 是唯一的入口。
 */
export async function purgeRequest(
  dbName: string,
  body: PurgeBody,
): Promise<Record<string, string[]> | undefined> {
  const { nanoServer } = await import("./client")
  const res = await nanoServer.request({
    path: `${dbName}/_purge`,
    method: "POST",
    body,
  }) as { purged?: Record<string, string[]> } | undefined
  return res?.purged
}
