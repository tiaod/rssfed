import {
  authenticatedDbUrl,
  nanoServer,
  TIMELINE_REPLICATION_SELECTOR,
} from "./client"

/**
 * 用户时间线的聚合搬运：交给 **CouchDB 复制器**，但由**我们**决定"什么时候搬哪个源"。
 *
 * 搬运本身是一条 (源库 → 该用户聚合库) 的复制，用 **Mango selector** 只搬活文档，
 * 附件走 CouchDB 内部 multipart。**不带任何 `query_params`**。
 *
 * 为什么要 selector 而不再用 JS filter（刻意的语义变更）：
 *   旧实现靠「删除以 `_deleted` 变更跟着复制」让用户库成为源库的精确镜像，代价是每个删除
 *   都要留一个墓碑并被镜像进每个用户库。实测线上一个账号：4,717 条活文档配 **42,262 个墓碑
 *   （90%）**，浏览器首次全量拉取要读 4.8 万份文档、21.7 秒。而且这些墓碑里绝大多数**不是**
 *   源库现有墓碑的镜像（源库合计仅 803 个）—— 是旧实现里源库清理任务早已 purge 掉的删除，
 *   purge 不复制，于是永久留在每个用户库里。
 *
 *   新实现**接受墓碑静默丢失**：selector 只匹配活文档，删除进不了复制。于是"精确镜像"这条
 *   不变量换成「两侧各自独立执行同一条保留规则」——源库裁到每源最新 N 条（`retention.ts`），
 *   汇聚库也裁到每源最新 N 条（`services/timeline.ts` 的 reconcile 步骤），两侧都用 `_purge`，
 *   所以两侧都不产生墓碑。实测 8 轮随机抓取/裁剪：两侧条目集合每轮完全一致、墓碑恒为 0。
 *
 * 为什么不留常驻（continuous）复制（实测）：
 *   - 每个 (用户 × 源) 一条常驻复制时，625 条一起做首次追赶会把机器压死：
 *     CouchDB 162% CPU / 988MB、宿主 2 核 load 20.8、swap 1.6G/2G，源库都打不开；
 *   - 想用 `[replicator] max_jobs` 限流则必然**饿死**：常驻任务永不结束、不释放槽位，
 *     `max_jobs` 事实上变成"最多多少个源会被搬"（设 50 时 573 个源一条都搬不过来）。
 *   一次性复制把并发完全交给我们的队列（`TIMELINE_SYNC_CONCURRENCY`），机器压力可控，
 *   而"要搬哪个源"由 PG 里的水位表（`timeline_source_sync`）按
 *   `feeds.lastChangedAt / bots.lastNewEntryAt > synced_at` 判定 —— 没变化的源连一次复制请求都不发。
 *
 * 四条必须知道的边界（都实测过）：
 *   ① **selector 与 filter / doc_ids 互斥**：同时传直接 400
 *      （`doc_ids`,`filter`,`selector` are mutually exclusive）。所以源库不再需要装复制过滤器，
 *      `ensureReplicationFilter` 那套"存量库补装"逻辑一并删除。
 *   ② **selector 天然排除 `_design/*`**：设计文档没有 `type` 字段，进不了匹配。以前 filter
 *      的主要职责就是挡它，现在由 selector 顺手完成。
 *   ③ **checkpoint 按「源库 + 目标库 + 复制参数哈希」算**（两端 `_local/<哈希>`）：参数字面量
 *      不变则**永久复用**、接着上次序号继续。所以 selector 必须是**常量**
 *      （`TIMELINE_REPLICATION_SELECTOR`），里面不能出现随时间变化的谓词 —— 那会让每个
 *      (用户 × 源) 每天都从 0 重扫源库（早期把窗口下界塞进 `query_params` 就是这么坏掉的）。
 *   ④ 复制是"变更投递"不是"投影"：目标端 purge 过的文档，只要源端之后**没有新修订**就不会被
 *      送回来；源端有了新修订则会被重新搬过去（这是"恢复历史"，可接受）。
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
export interface ReplicateResponse {
  ok?: boolean
  session_id?: string
  source_last_seq?: string | number
  history?: Array<{
    session_id?: string
    docs_written?: number
    docs_read?: number
    doc_write_failures?: number
  }>
  error?: string
  reason?: string
}

export interface SourceReplicationResult {
  /** 本次真正写进目标库的文档数（含 FeedDoc 与删除投递，不只是条目） */
  docsWritten: number
  /** 本次复制到达的源库序号（诊断用，落进水位表） */
  sourceLastSeq: string | null
  elapsedMs: number
  /** 本次复制目标端写失败的文档数（>0 时调用方不应推进水位，见下方说明） */
  writeFailures: number
}

/**
 * 从 `_replicate` 响应里取出**本次会话**的写入数。
 *
 * 坑（实测）：CouchDB 的 `history[].docs_written / doc_write_failures` 是**这个复制任务的
 * 累计值**，不是本会话增量；而且**没有产生新 checkpoint 的会话（无变化）不会追加 history
 * 条目**，此时响应里 `history[0]` 是上一次会话的旧数据、`session_id` 也是旧的。
 * 所以：
 *   - 先用顶层 `session_id` 在 history 里找当前会话；找不到 = 无变化，本次写了 0；
 *   - 找到后与**上一条** history 相减，才是本次的写入/失败数。
 * 不这样算的话，日志里的"搬入 N 份"会一直是累计值（实测一个 4 千墓碑的源每轮都报
 * 4,782 份，看起来像每轮都在重搬）。
 */
export function summarizeReplicationSession(res: ReplicateResponse): { docsWritten: number, writeFailures: number } {
  const history = res.history ?? []
  const sessionId = res.session_id
  if (!sessionId) return { docsWritten: 0, writeFailures: 0 }
  const index = history.findIndex(entry => entry.session_id === sessionId)
  if (index < 0) return { docsWritten: 0, writeFailures: 0 }
  const current = history[index]!
  const previous = history[index + 1]
  return {
    docsWritten: Math.max(0, (current.docs_written ?? 0) - (previous?.docs_written ?? 0)),
    writeFailures: Math.max(0, (current.doc_write_failures ?? 0) - (previous?.doc_write_failures ?? 0)),
  }
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
      // 只搬活文档：墓碑进不了 selector（删除后没有字段可匹配），这正是本方案要的
      // 「墓碑静默丢失」；删除由两侧各自的保留策略独立完成，不靠传播。
      // **这个对象必须是常量**：它参与 checkpoint 哈希，随时间变就是从 0 重扫。
      selector: TIMELINE_REPLICATION_SELECTOR,
      // **没有任何 query_params**：换参数就是换哈希 → 从 0 重扫源库。
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

  const { docsWritten, writeFailures } = summarizeReplicationSession(res)
  // 排查开关：单源复制的参数与计数（正常不打印 —— 一次聚合可能有几百个源）
  if (process.env.TIMELINE_DEBUG_REPLICATION === "1") {
    console.log("[Timeline][debug] 复制", JSON.stringify({
      source: spec.sourceDb,
      target: spec.targetDb,
      ok: res?.ok,
      error: res?.error,
      reason: res?.reason,
      session_id: res?.session_id,
      docs_written: docsWritten,
      doc_write_failures: writeFailures,
      source_last_seq: res?.source_last_seq,
    }))
  }
  if (res?.error) {
    throw new Error(`复制失败：${res.error}${res.reason ? `（${res.reason}）` : ""}`)
  }
  // 写失败**不在这一层抛**：无变化时响应里的 history 是上次会话的旧数据（见
  // summarizeReplicationSession），拿旧失败当新失败会让水位永远卡住。调用方先判断
  // 「这次有没有真的推进 checkpoint」（`sourceLastSeq` 与水位里的值比较），再决定是否失败。
  return {
    docsWritten,
    sourceLastSeq: res?.source_last_seq != null ? String(res.source_last_seq) : null,
    elapsedMs: Date.now() - startedAt,
    writeFailures,
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
