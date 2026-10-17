import {
  authenticatedDbUrl,
  nanoServer,
  REPLICATION_FILTER_PATH,
} from "./client"

/**
 * 用户时间线的聚合搬运：交给 **CouchDB 复制器**，但由**我们**决定"什么时候搬哪个源"。
 *
 * 搬运本身是一条 (源库 → 该用户聚合库) 的复制，过滤器挂在源库设计文档上（`main/timeline`，
 * 职责降级为"只挡设计文档"），附件走 CouchDB 内部 multipart。**不带任何 `query_params`**：
 * 保留策略的唯一权威是**源库裁剪**（每条源只留最新 N 条，见
 * `docs/notes/aggregation/source-side-retention-plan.md`），复制只做精确镜像。
 *
 * 与早期实现的区别只有一点：**不再创建常驻（continuous）复制**，改成 `POST /_replicate` 的
 * **一次性同步复制**，由 `rss-timeline-sync` 队列限并发地触发。
 *
 * 为什么不留常驻任务（实测）：
 *   - 每个 (用户 × 源) 一条常驻复制时，625 条一起做首次追赶会把机器压死：
 *     CouchDB 162% CPU / 988MB、宿主 2 核 load 20.8、swap 1.6G/2G，源库都打不开；
 *   - 想用 `[replicator] max_jobs` 限流则必然**饿死**：常驻任务永不结束、不释放槽位，
 *     `max_jobs` 事实上变成"最多多少个源会被搬"（设 50 时 573 个源一条都搬不过来）。
 *   一次性复制把并发完全交给我们的队列（`TIMELINE_SYNC_CONCURRENCY`），机器压力可控，
 *   而"要搬哪个源"由 PG 里的水位表（`timeline_source_sync`）按
 *   `feeds.lastChangedAt / bots.lastNewEntryAt > synced_at` 判定 —— 没变化的源连一次复制请求都不发。
 *
 * 四条必须知道的边界（都实测过，见 docs/notes/aggregation/ 下的留档与
 * report/aggregation-* 的探针输出）：
 *   ① **过滤器只能用 JS filter**：Mango selector 不搬删除（删除后的文档没有字段可匹配），
 *      而「源端删除跟随」正是本方案让用户库保持镜像的机制。
 *   ② **checkpoint 是按「源库 + 目标库 + 过滤器源码」算的**（两端 `_local/<哈希>`）：同一份
 *      过滤器再调一次会**接着上次的序号继续**；改了过滤器源码就是新哈希 → 从 0 重扫。
 *      所以过滤器里不能写随时间的谓词（早期把窗口下界塞进 `query_params` 就是这么坏掉的）。
 *   ③ **不带 `query_params` 也就少一个坑**：以前参数名不能叫 `since`（会和 `_changes` 的
 *      since 撞名），现在整块消失了。
 *   ④ 复制是"变更投递"不是"投影"：目标端**自己删过**的文档不会再被送回来（目标端已经认识
 *      那个 rev，见 probe-e）。要找回历史只能走「重建」（重建聚合库后重搬）。
 */

/** 本服务创建的**历史**常驻复制文档前缀：升级后要把它们清掉（见 purgeLegacyReplications） */
const REPLICATION_PREFIX = "rssfed-"

/** `_replicator` 是 CouchDB 的系统库，需要 admin 凭据（我们用的就是 admin） */
const REPLICATOR_DB = "_replicator"

/**
 * 历史遗留的常驻复制文档 id：`rssfed-{userId}:w{windowDays}:{sourceId}`。
 *
 * **新实现不再创建这种文档**，这里保留构造/解析是为了升级清理：
 * 老版本给每个 (用户 × 源) 建了一条常驻复制，升级后必须把它们删掉，
 * 否则那些任务会继续常驻并抢机器。
 *
 * 顺带一个仍然成立的性质：checkpoint 由**复制参数哈希**决定，不随文档 id 改变、
 * 也不会因为删掉复制文档而消失（实测：同参数重建任务，内容不会重搬）。所以清理这些
 * 遗留文档**不会**影响新的一次性复制 —— 新复制用 `continuous: false`，哈希本来就不同。
 */
export function replicationDocId(userId: string, windowDays: number, sourceId: string): string {
  return `${REPLICATION_PREFIX}${userId}:w${windowDays}:${sourceId}`
}

export interface ParsedReplicationId {
  userId: string
  windowDays: number
  sourceId: string
}

/** 解析本服务创建的复制文档 id（不是我们的返回 null） */
export function parseReplicationDocId(id: string): ParsedReplicationId | null {
  if (!id.startsWith(REPLICATION_PREFIX)) return null
  const match = /^([^:]+):w(\d+):(.+)$/.exec(id.slice(REPLICATION_PREFIX.length))
  if (!match) return null
  return { userId: match[1]!, windowDays: Number(match[2]), sourceId: match[3]! }
}

/** 单源一次性复制的超时上限。单源常态是几百毫秒（实测：无更新空转 1.3s、增量 1.7s、
 *  168 条 × 20KB 全量 3.5s）；超时说明源库异常大或 CouchDB 卡住，让任务失败重试比挂死好。 */
const REPLICATION_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.TIMELINE_REPLICATION_TIMEOUT_MS ?? "120000") || 120_000)

/** `POST /_replicate` 的响应：真正关心的计数在 `history[0]` 里 */
interface ReplicateResponse {
  ok?: boolean
  source_last_seq?: string | number
  history?: Array<{ docs_written?: number, docs_read?: number, doc_write_failures?: number }>
  error?: string
  reason?: string
}

export interface SourceReplicationResult {
  /** 本次真正写进目标库的文档数（含 FeedDoc 与删除投递，不只是条目） */
  docsWritten: number
  /** 本次复制到达的源库序号（诊断用，落进水位表） */
  sourceLastSeq: string | null
  elapsedMs: number
}

/**
 * 跑一次**一次性**单源复制（同步等待完成），返回本次写了多少文档。
 *
 * 用 `POST /_replicate` 而不是往 `_replicator` 库塞文档：后者会经过 CouchDB 的调度器
 * （`max_jobs` / `max_churn`），于是并发又变成"由 CouchDB 决定"——而那正是常驻方案里
 * 饿死与过载并存的根源。`_replicate` 是一次同步调用，并发完全由调用方（我们的队列）控制。
 *
 * checkpoint 与 `_replicator` 完全一致（两端 `_local/<参数哈希>`）：同参数的下一次调用
 * 接着上次的序号继续；传了不同的 `boundIso` 就是新哈希，会从 0 重扫（探针实测）。
 */
export async function runSourceReplication(spec: {
  sourceDb: string
  targetDb: string
  /**
   * @deprecated 过渡期保留字段：**已不参与复制**。下界计算与水位里的 bound 会随
   * `windowDays` / `minFeedEntries` 一起删掉（见 source-side-retention-plan.md §11）。
   */
  boundIso?: string | null
}): Promise<SourceReplicationResult> {
  const startedAt = Date.now()
  const timer = { timedOut: false }
  const request = nanoServer.request({
    path: "_replicate",
    method: "POST",
    body: {
      // 源/目标必须是**带凭据的完整 URL**：裸库名会被复制器当远端地址解析
      // （报 `Could not open source database http://any:5984/...`，实测踩过）
      source: authenticatedDbUrl(spec.sourceDb),
      target: authenticatedDbUrl(spec.targetDb),
      // 一次性：不常驻。checkpoint 由参数哈希决定，与 continuous 无关地在下次调用时复用
      continuous: false,
      create_target: false,
      filter: REPLICATION_FILTER_PATH,
      // **没有任何 query_params**：保留策略的唯一权威是源库裁剪，复制只做精确镜像。
      // 参数一旦进这里，换参数就是换哈希 → 从 0 重扫源库；而且窗口过滤会和源库裁剪
      // 变成两套权威（用户库不再自己剪枝）。
    },
  }) as Promise<ReplicateResponse>

  let res: ReplicateResponse
  try {
    res = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          timer.timedOut = true
          reject(new Error(`单源复制超过 ${REPLICATION_TIMEOUT_MS}ms 未完成`))
        }, REPLICATION_TIMEOUT_MS).unref?.()
      }),
    ])
  } catch (err) {
    // 超时/网络错：复制可能还在 CouchDB 侧继续，但水位不会推进（syncedAt 仍是开始时刻），
    // 所以下一轮一定会补 —— checkpoint 让重试只搬没搬完的部分，不会重搬。
    const message = (err as Error)?.message ?? String(err)
    throw new Error(timer.timedOut ? message : `复制请求失败：${message}`)
  }

  const history = res?.history?.[0]
  // 排查开关：单源复制的参数与计数（正常不打印 —— 一次聚合可能有几百个源）
  if (process.env.TIMELINE_DEBUG_REPLICATION === "1") {
    console.log("[Timeline][debug] 复制", JSON.stringify({
      source: spec.sourceDb,
      target: spec.targetDb,
      ok: res?.ok,
      error: res?.error,
      reason: res?.reason,
      docs_read: history?.docs_read,
      docs_written: history?.docs_written,
      doc_write_failures: history?.doc_write_failures,
      source_last_seq: res?.source_last_seq,
    }))
  }
  return {
    docsWritten: typeof history?.docs_written === "number" ? history.docs_written : 0,
    sourceLastSeq: res?.source_last_seq != null ? String(res.source_last_seq) : null,
    elapsedMs: Date.now() - startedAt,
  }
}

// `_replicator` 库默认不存在（CouchDB 用到时才建），进程内只尝试创建一次
let replicatorDbEnsured = false

/** 确保 `_replicator` 库存在（已存在时 CouchDB 返回 412，忽略） */
export async function ensureReplicatorDatabase(): Promise<void> {
  if (replicatorDbEnsured) return
  try {
    await nanoServer.db.create(REPLICATOR_DB)
  } catch {
    // 已存在（412）/ 并发创建：真正的"库不可用"会在后面的读写里抛出来，这里不掩盖
  }
  replicatorDbEnsured = true
}

export interface UserReplication extends ParsedReplicationId {
  docId: string
  /** 文档 _rev（删除时要用，顺手从 `_all_docs` 的 value 里带出来） */
  rev: string
}

/** 单页大小与最大页数：一个用户的订阅源数量级是几百，留够余量 */
const LIST_PAGE = 500
const LIST_MAX_PAGES = 20

/**
 * 列出该用户当前的复制任务。
 *
 * 这份列表就是「哪些源已经在搬」的**唯一真相**：状态文档里不再记每源游标，
 * 退订清理与窗口变化都靠它与当前订阅集合做差集。
 */
export async function listUserReplications(userId: string): Promise<UserReplication[]> {
  await ensureReplicatorDatabase()
  const scope = nanoServer.use(REPLICATOR_DB)
  const prefix = `${REPLICATION_PREFIX}${userId}:`
  const endkey = `${prefix}\uffff`
  const found: UserReplication[] = []
  let startkey = prefix
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const { rows } = await scope.list({
      startkey,
      endkey,
      limit: LIST_PAGE,
      // 第二页起跳过上一页的最后一行（startkey 是含端点的）
      ...(page === 0 ? {} : { skip: 1 }),
    })
    for (const row of rows) {
      const parsed = parseReplicationDocId(row.id)
      const rev = (row.value as { rev?: string } | null)?.rev
      if (parsed && rev) found.push({ docId: row.id, rev, ...parsed })
    }
    if (rows.length < LIST_PAGE) break
    startkey = rows[rows.length - 1]!.id
  }
  return found
}

/**
 * 清理该用户**历史遗留的常驻复制任务**（升级一次性执行，之后 `_replicator` 里不再有我们的文档）。
 *
 * 不清理的后果：老任务会继续常驻，每条都占一个调度槽 + 一条 `_changes` 长轮询，
 * 既白占资源，又会和新的按需复制抢 CouchDB 的复制器。
 *
 * 只删本服务前缀的文档（`rssfed-{userId}:`），别人的任务不碰。
 */
export async function purgeLegacyReplications(userId: string): Promise<number> {
  const existing = await listUserReplications(userId)
  if (existing.length === 0) return 0
  await deleteReplications(existing.map(item => ({ docId: item.docId, rev: item.rev })))
  return existing.length
}

/** 批量删除复制任务（升级清理时逐条删会串行很多次往返） */
export async function deleteReplications(items: Array<{ docId: string, rev: string }>): Promise<void> {
  if (items.length === 0) return
  await ensureReplicatorDatabase()
  const scope = nanoServer.use(REPLICATOR_DB)
  const docs = items.map(item => ({ _id: item.docId, _rev: item.rev, _deleted: true }))
  // 冲突（并发删除）不算失败：目标是"这条任务没了"
  await scope.bulk({ docs })
}
