import {
  authenticatedDbUrl,
  nanoServer,
  REPLICATION_FILTER_PATH,
  TIMELINE_REPLICATION_FILTER_QUERY_PARAM,
} from "./client"

/**
 * 用户时间线的聚合搬运：交给 **CouchDB 复制器**，我们只维护「谁该复制谁」这份拓扑。
 *
 * 每个 (用户 × 订阅源) 一条**常驻复制**（`_replicator` 里的一个文档）：
 *   source = 源库（`feed_*` / `bot_*`），target = 该用户的聚合库，
 *   JS filter 按窗口过滤（放行 FeedDoc 与删除，见 client.ts 的 TIMELINE_REPLICATION_FILTER）。
 *
 * 为什么不用自己读 `_changes` 再写：附件在 CouchDB 内部走 multipart，二进制、不经过我们的
 * 进程、不吃内存、没有 base64 往返；写入按源库修订谱系落库（`new_edits: false`），天然幂等；
 * 增量由复制器自己的 `_changes` 长轮询驱动，稳态下比"每轮对每个源发一次请求"还便宜。
 *
 * 四条必须知道的边界（都实测过，见 docs/notes/aggregation/couchdb-replicator-aggregation.md）：
 *   ① **过滤器只能用 JS filter**：Mango selector 不搬删除（删除后的文档没有字段可匹配），
 *      而「源端删除跟随」是必须成立的性质。
 *   ② **query_params 里不能有叫 `since` 的参数**：它会和 `_changes` 自己的 since 撞名，
 *      过滤器读到的是序号字符串，窗口会静默失效。
 *   ③ **复制器的 checkpoint 是按「复制参数哈希」存的**：删掉复制文档不会重置它（两端
 *      `_local/<哈希>` 都还在）。所以「同参数重建任务」不会重搬任何东西；而**换了
 *      参数（窗口下界）就是换了哈希**，复制器会从 0 扫一遍源库 —— 窗口放大要的回填正是
 *      靠它自动发生的。
 *   ④ 复制是"变更投递"不是"投影"：目标端**自己删过**的文档不会再被送回来（目标端已经
 *      认识那个 rev）。所以剪枝（窗口收窄）留在服务端做，且它是**单向**的 —— 剪掉的历史
 *      不会因为之后把窗口放大而回来，要找回历史只能走「重建」（重建聚合库后重搬）。
 */

/** 本服务创建的复制文档一律带这个前缀，便于按用户列举与清理 */
const REPLICATION_PREFIX = "rssfed-"

/** `_replicator` 是 CouchDB 的系统库，需要 admin 凭据（我们用的就是 admin） */
const REPLICATOR_DB = "_replicator"

/**
 * 复制文档 id：`rssfed-{userId}:w{windowDays}:{sourceId}`。
 *
 * 为什么把 windowDays 编进 id：复制器的 checkpoint 由**复制参数哈希**决定，它不随文档 id
 * 改变、也不会因为删掉复制文档而消失（实测：同参数重建任务，内容不会重搬）。把窗口编进
 * id，reconcile 就能用「列出现有任务 + 差集」判断哪些任务过期了 —— 窗口一变就是另一条
 * 任务（另一份 query_params = 另一个哈希 = 从 0 重扫），旧任务删掉即可。
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

/**
 * 复制任务的过滤参数。`minPublishedAt` 只在**创建时**算一次并保持不变。
 *
 * 下界若随时间推移，每轮都得改参数，而改参数 = 换哈希 = 丢 checkpoint 从头重扫，
 * 代价不可接受。代价是过滤器会越来越"松"（多放行一些刚滑出窗口的老条目），
 * 但窗口的权威是剪枝（services/timeline.ts 的 pruneOlderThan）——多进来的会被删掉。
 *
 * 反过来，**窗口变大时下界也会变 → 换哈希 → 复制器从 0 扫源库**，这正是"放大窗口
 * 回填历史"要的行为（`probe-4` 实测 2.4s）；但已经被剪掉的条目回不来（见模块头注释 ④）。
 */
export function replicationQueryParams(
  windowDays: number,
  boundIso: string,
): Record<string, string> {
  const params: Record<string, string> = {}
  if (windowDays > 0) params[TIMELINE_REPLICATION_FILTER_QUERY_PARAM] = boundIso
  return params
}

/** 创建过滤参数时用的固定下界 */
export function initialWindowBoundIso(windowDays: number, now: number = Date.now()): string {
  return new Date(now - windowDays * 86_400_000).toISOString()
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

export interface ReplicationSpec {
  userId: string
  windowDays: number
  /** 源 id：feedId 或 `bot:{botId}`（只用于生成文档 id 与排查，不参与复制本身） */
  sourceId: string
  /** 源库名（`feed_*` / `bot_*`） */
  sourceDb: string
  /** 目标库名（`user-timeline_*`） */
  targetDb: string
}

/**
 * 确保一条复制任务存在，返回是否**新建**。
 *
 * 已存在就原样返回、绝不更新（改参数会丢 checkpoint 重扫，见边界 ③）；
 * 稳态下一轮 reconcile 应该一个写请求都不发。
 */
export async function ensureReplication(spec: ReplicationSpec): Promise<"created" | "exists"> {
  await ensureReplicatorDatabase()
  const id = replicationDocId(spec.userId, spec.windowDays, spec.sourceId)
  const scope = nanoServer.use(REPLICATOR_DB)
  try {
    await scope.get(id)
    return "exists"
  } catch {
    // 不存在：继续创建（真正建不出来的错误会在 insert 里抛出来）
  }

  const doc: Record<string, unknown> = {
    _id: id,
    source: authenticatedDbUrl(spec.sourceDb),
    target: authenticatedDbUrl(spec.targetDb),
    continuous: true,
    create_target: false,
    // JS filter 而不是 selector：只有它能搬删除（见 client.ts 的 TIMELINE_REPLICATION_FILTER）
    filter: REPLICATION_FILTER_PATH,
    query_params: replicationQueryParams(spec.windowDays, initialWindowBoundIso(spec.windowDays)),
  }

  try {
    await scope.insert(doc as never)
    return "created"
  } catch (err) {
    // 同一用户的两次 reconcile 撞车（定时轮询 + 手动刷新）时 409，等价于"已经有了"
    if ((err as { statusCode?: number })?.statusCode === 409) return "exists"
    throw err
  }
}

/** 批量删除复制任务（窗口变化要换掉整个用户的任务集，逐条删会串行很多次往返） */
export async function deleteReplications(items: Array<{ docId: string, rev: string }>): Promise<void> {
  if (items.length === 0) return
  await ensureReplicatorDatabase()
  const scope = nanoServer.use(REPLICATOR_DB)
  const docs = items.map(item => ({ _id: item.docId, _rev: item.rev, _deleted: true }))
  // 冲突（并发删除）不算失败：目标是"这条任务没了"
  await scope.bulk({ docs })
}

/** 删除单条复制任务（不存在则忽略） */
export async function deleteReplication(docId: string): Promise<void> {
  const scope = nanoServer.use(REPLICATOR_DB)
  try {
    const doc = await scope.get(docId) as { _rev: string }
    await scope.destroy(docId, doc._rev)
  } catch {
    // 已不存在
  }
}

export interface ReplicationJobState {
  docId: string
  /** 调度状态：running / pending / crashing / completed … */
  state: string | null
  changesPending: number | null
  docsWritten: number | null
}

/**
 * 读某条复制任务的调度状态（运维排查入口，`GET /_scheduler/docs/_replicator/<文档 id>`）。
 *
 * **不要用它判断"追平了没有"**：`checkpointed_source_seq` 只在复制器按 `worker_batch_size`
 * 批量落 checkpoint 时才更新，明显滞后于文档真正到端。手动同步的等待走派生库 `_changes`
 * （见 services/timeline.ts 的 waitForSync）。
 */
export async function getReplicationState(docId: string): Promise<ReplicationJobState | null> {
  try {
    const res = await nanoServer.request({
      path: `_scheduler/docs/${REPLICATOR_DB}/${encodeURIComponent(docId)}`,
      method: "GET",
    }) as { state?: string, info?: { changes_pending?: number, docs_written?: number } }
    return {
      docId,
      state: res?.state ?? null,
      changesPending: typeof res?.info?.changes_pending === "number" ? res.info.changes_pending : null,
      docsWritten: typeof res?.info?.docs_written === "number" ? res.info.docs_written : null,
    }
  } catch {
    return null
  }
}
