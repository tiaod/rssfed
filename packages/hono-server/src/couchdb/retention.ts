/**
 * 库裁剪：**每条源只保留最新 N 条**，用 `_purge` 而不是标准 delete。
 *
 * 新模型下只有一种库要裁：owner 库（用户库 / Bot 库）。一个库里装着几百个源，
 * 所以要**按源分组**各留 N 条，入口是 `trimOwnerFeedToLatestN(dbName, feedId, n)`。
 * 抓取路径里「写完新条目顺手裁这一个源」和每日的自适应保留任务都走它。
 *
 * 为什么是 `_purge` 而不是 delete、保留条数怎么算：取舍与实测数据见
 * `ARCHITECTURE.md` 的「保留策略」一条，这里不重复。**改这条策略前先读那一节。**
 *
 * ## 三条仍然成立的边界
 *
 * 1. **`_purge` 不留墓碑**：清完该 id 在 `_all_docs?keys=` 里返回 `not_found`（**不是**
 *    tombstone），抓取路径的 `partitionByExistence` 会把它当成"从未出现"。抓取路径靠
 *    `workers/entry-selection.ts` 的 `selectNewestItems` 挡住复活（写库前先按 publishedAt
 *    截到最新 N 条，被 purge 的老条目进不了候选，实测零复活）；只有把 N 调大时会"恢复历史"。
 * 2. **并列时间戳**：按视图行序（key, doc id 的全序）删最旧的 `total - N` 条，所以"最多 N 条"
 *    是真的最多（下界方案遇到几百条同 time 的批量抓取会一条都删不掉，实测停在 467 条）。
 *    但并列时保留的是 **id 较大**的那些，而抓取侧 `selectNewestItems` 并列时保持 **feed 原有
 *    顺序** —— 两者不是同一个全序。N 不变时无所谓；一旦并列组跨过 N 的边界，就会出现"抓取窗口
 *    与裁剪窗口各留一批"，下一轮按 `not_found` 把另一批写回、再被 purge，形成每轮固定条数的
 *    写回+删除（实测 N=10 时每轮 1 条；全并列时每轮 8 条）。库稳定停在 N 条、不影响正确性，
 *    但是一份常态写放大。
 * 3. **`publishedAt` 乱序**：刚抓到但发布时间很老的条目会被立刻裁掉（与旧行为一致）。
 *
 * 磁盘：purge 后 `doc_del_count` 立刻下降，但文件字节要 `_compact` 才回落（实测清理 879 个
 * 墓碑 + compact 后文件 12.0MB → 12.2MB，**几乎不降**）。所以清理的收益是**同步量**而不是磁盘，
 * 压缩按 CouchDB 自己的 smoosh 节奏走，本模块不主动 compact。
 */
import { createCouchDb } from "./client"

/** 每条源保留的条数（方案建议 50 = 旧 `minFeedEntries` 默认值，顺便解决低频源兜底） */
export const DEFAULT_SOURCE_RETENTION_ENTRIES = 50
/** 单批清理条数（首次裁剪要限速，见方案 §5 风险 1） */
const DEFAULT_TRIM_BATCH = 200
/** 单次裁剪最多跑几批（剩下的下次抓取再删，避免一次删几千条） */
const DEFAULT_TRIM_MAX_BATCHES = 10
/**
 * owner 库（用户库 / Bot 库）用的 view：`_design/main/by-feed-date`。
 *
 * 用户库里的条目来自多个源，裁剪要**按源分组**各留 N 条（不是全库留 N 条）。
 * 视图定义与配额在 `couchdb/client.ts` 的 `OWNER_DESIGN_DOC_VIEWS` 里，两份必须一致 ——
 * 设计文档 id 是 `_design/main`（旧模型里用户库用的是 `_design/timeline-maintain`，
 * 那份随"共享源库 + 复制"一起删除了）。
 */
export const USER_TIMELINE_TRIM_VIEW = "main/by-feed-date"
/** 逐源裁剪时每次从视图读多少行（一页里按 feedId 分组处理） */
const PER_FEED_TRIM_PAGE = 5_000

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

/**
 * 只裁**一个源**：把该 owner 库里 `feedId` 那一组裁到最新 N 条。
 *
 * 只处理一个源、成本 O(N)，适合**抓完顺手裁**与每日自适应保留（两者都按源逐个处理）。
 * 用户库一个库里装着几百个源，若改成整库遍历会让每次抓取都退化成 O(全库)。
 *
 * 为什么用视图整组读而不是分页：分页会把同一个源切在两页之间，按半截裁会误删本该
 * 保留的条目（少留不可逆），而"跳过等下一轮"又永远轮不到它（实测 25 条要裁到 5 条时，
 * 跳过写法每轮都删 0 条，永不收敛）。单源一整组受保留条数约束（≤ N，实测最大 50 档），
 * 整组读进内存是安全的；`limit` 仍给个上限兜住异常大的库。
 *
 * @returns 实际清掉的条数
 */
export async function trimOwnerFeedToLatestN(
  dbName: string,
  feedId: string,
  n: number,
  options: { batchSize?: number, maxBatches?: number, viewPath?: string } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_TRIM_BATCH
  const maxBatches = options.maxBatches ?? DEFAULT_TRIM_MAX_BATCHES
  const [design, view] = (options.viewPath ?? USER_TIMELINE_TRIM_VIEW).split("/") as [string, string]
  const db = createCouchDb(dbName)
  let deleted = 0

  for (let batch = 0; batch < maxBatches; batch++) {
    const res = await db.view(design, view, {
      startkey: [feedId, ""],
      endkey: [feedId, {}],
      include_docs: true,
      limit: PER_FEED_TRIM_PAGE,
    }) as unknown as { rows?: Array<{ doc?: { _id?: string, _rev?: string } }> }
    const docs = (res.rows ?? [])
      .map((row) => row.doc)
      .filter((doc): doc is { _id: string, _rev: string } => Boolean(doc?._id && doc?._rev))
    const excess = docs.length - n
    if (excess <= 0) break
    const victims = docs.slice(0, Math.min(excess, batchSize))
    const body = buildPurgeBody(victims)
    const purged = await purgeRequest(dbName, body)
    const removed = countPurged(purged, body)
    deleted += removed
    // 一条都没清掉说明撞上并发（文档刚被改过、rev 不匹配）：停手，下一轮再来
    if (removed === 0) break
  }
  return deleted
}

/**
 * 直接发 `_purge`（admin 连接）。抽成独立函数是因为三个调用方（逐源裁剪、退订清理、
 * Bot 产出同步清理）都要用，而 nano 的 `request` 是唯一的入口。
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
