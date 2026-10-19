/**
 * 源库**墓碑清理**的 CouchDB 侧机制（"什么时候能清"的判定在 services/timeline-maintenance.ts）。
 *
 * 背景：源库裁剪（`couchdb/retention.ts`）用标准 delete 留墓碑 —— 墓碑是"删除能传播 /
 * 重扫不复活"的载体，代价是只增不减。新订阅 / 重建时复制从 0 重扫，会把源库全部历史墓碑
 * 搬进用户库（实测一个重历史源一次写 5.1 万份）。GC 在**所有活跃订阅者都已越过某个墓碑**后
 * 把它 `_purge` 掉再 compact，首搬就只剩源库当前 ≤N 条活文档。
 *
 * 这里的三个关键事实都实测过（见 report/aggregation-*）：
 *   1. `_purge` 请求体用**旧格式** `{"<docid>": ["<rev>"]}`（CouchDB 3.5 对 `docids` 格式
 *      报 `Invalid rev format`）；响应 `{purged: {id: [revs]}}`，rev 不存在时该 id 返回空数组
 *      （幂等：可以当成"已经没有这个墓碑了"）。
 *   2. purge **会重写 `_changes` 的序号**（同一行 purge 前后 seq token 不同，甚至变小）。
 *      所以判断"订阅者是否已越过墓碑"**不能用 seq 比较**，只能用时间：
 *      墓碑 first_seen_at < 所有活跃订阅者最近一次成功同步的 synced_at。旧 checkpoint token
 *      仍然可用（实测 purge 后复制按旧 checkpoint 继续，不丢删除），但新代码不依赖它做安全判定。
 *   3. purge 后 `doc_del_count` 立刻下降，磁盘字节要 `_compact` 才回落；compaction 不删墓碑本身。
 */
import { nanoServer } from "./client"

/** 只清条目墓碑：`feed:{id}` 元信息与设计文档的墓碑不占量，也没有"重扫搬回来"的问题 */
export const TOMBSTONE_ENTRY_PREFIX = "entry:"

/** 每个源库里的 GC 进度（`_local` 文档不会被复制、不进 `_changes`，正合适） */
const GC_CHECKPOINT_DOC = "_local/tombstone-gc"

export interface TombstoneCandidate {
  docId: string
  rev: string
}

export interface TombstoneGcCheckpoint {
  /** `_changes` 游标（CouchDB 的 seq token；purge 重写序号后旧 token 仍可继续用） */
  changesSince: string | number | null
  /** 上次为"让订阅者越过墓碑"而 bump 源 `lastChangedAt` 的时刻（节流用） */
  lastNudgeAt: string | null
}

/** 某个源的一个订阅者水位：判定"能不能清"只需要这两列 */
export interface SubscriberWatermark {
  syncedAt: Date | null
  status: string
}

export type TombstoneCutoff =
  | { mode: "all" }
  | { mode: "blocked", reason: string }
  | { mode: "before", before: Date }

/**
 * 计算该源现在能清到哪个时刻之前 —— **纯函数**，边界由单测钉住。
 *
 * 规则（为什么这样是安全的，见 ARCHITECTURE.md「墓碑清理」）：
 *   - 没有活跃订阅者 → 全清（新订阅者的首搬只需要活文档）。
 *   - 有任何订阅者还没完成过一次成功同步（`synced_at is null` / `status != idle`）→ 不清：
 *     他那份库里可能还留着该删的条目，等这次同步完成再说。
 *   - 否则只清 `first_seen_at < min(syncedAt) - grace` 的墓碑：那个同步开始之后源库的
 *     `_changes` 一定能读到它（要么在本次窗口内，要么更早的 checkpoint 已经投递过）。
 */
export function computeTombstoneCutoff(
  subscribers: SubscriberWatermark[],
  graceMs: number,
): TombstoneCutoff {
  if (subscribers.length === 0) return { mode: "all" }

  let oldestSync = Number.POSITIVE_INFINITY
  for (const subscriber of subscribers) {
    if (!subscriber.syncedAt || subscriber.status !== "idle") {
      const reason = subscriber.syncedAt
        ? `有订阅者上次同步未完成（status=${subscriber.status}）`
        : "有订阅者还没有成功同步过"
      return { mode: "blocked", reason }
    }
    oldestSync = Math.min(oldestSync, subscriber.syncedAt.getTime())
  }
  return { mode: "before", before: new Date(oldestSync - Math.max(0, graceMs)) }
}

/** 从待清列表里挑出当前可清的墓碑（纯函数） */
export function selectPurgeable<T extends { firstSeenAt: Date }>(
  rows: T[],
  cutoff: TombstoneCutoff,
): T[] {
  if (cutoff.mode === "all") return rows
  if (cutoff.mode === "blocked") return []
  return rows.filter((row) => row.firstSeenAt.getTime() < cutoff.before.getTime())
}

/** 把一批 `_changes` 结果里的"条目墓碑"挑出来（单叶删除；有冲突分支的不动） */
export function deletedTombstoneCandidates(results: Array<{
  id?: string
  deleted?: boolean
  changes?: Array<{ rev?: string }>
}>): TombstoneCandidate[] {
  const candidates: TombstoneCandidate[] = []
  for (const row of results) {
    if (!row.deleted) continue
    if (typeof row.id !== "string" || !row.id.startsWith(TOMBSTONE_ENTRY_PREFIX)) continue
    const changes = row.changes ?? []
    // 只处理单叶墓碑：多叶说明同一 id 上还有别的分支（历史冲突），purge 掉可能让活分支
    // 重新变成 winner（复活）；这种极少，留给人工/重建处理。
    if (changes.length !== 1) continue
    const rev = changes[0]?.rev
    if (typeof rev !== "string" || rev.length === 0) continue
    candidates.push({ docId: row.id, rev })
  }
  return candidates
}

/** 按页大小切块（purge 请求不能无限大） */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`chunkArray: size 必须是正整数，收到 ${size}`)
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/** GC 对单个源库需要的全部 CouchDB 操作；抽出来是为了 dry-run / 单测注入 */
export interface TombstoneGcStore {
  readCheckpoint(): Promise<TombstoneGcCheckpoint>
  writeCheckpoint(checkpoint: TombstoneGcCheckpoint): Promise<void>
  /** 从 changes 游标往后读一页，返回本页的条目墓碑与新游标 */
  scanChanges(since: string | number | null, limit: number): Promise<{
    candidates: TombstoneCandidate[]
    rows: number
    nextSince: string | number | null
    hasMore: boolean
  }>
  /** admin 级 `_purge`；返回真正清掉的 rev 数（rev 不存在时不计） */
  purge(candidates: TombstoneCandidate[]): Promise<{ purged: number, requested: number }>
  compact(): Promise<void>
  /** 当前墓碑总数（用于发现"库被外部清过"的残留待办） */
  tombstoneCount(): Promise<number>
}

export function createTombstoneGcStore(dbName: string): TombstoneGcStore {
  const db = nanoServer.use(dbName)

  return {
    async readCheckpoint() {
      try {
        const doc = await db.get(GC_CHECKPOINT_DOC) as { changesSince?: string | number | null, lastNudgeAt?: string | null }
        return {
          changesSince: doc?.changesSince ?? null,
          lastNudgeAt: typeof doc?.lastNudgeAt === "string" ? doc.lastNudgeAt : null,
        }
      } catch (err) {
        // 404 = 第一次跑（或库被重建）；从 0 开始扫一遍补录历史墓碑。
        // 其它错误（库打不开/超时）必须抛出：当成"没有 checkpoint"会退化成每轮全量重扫。
        if (isNotFoundError(err)) return { changesSince: null, lastNudgeAt: null }
        throw err
      }
    },

    async writeCheckpoint(checkpoint) {
      let rev: string | undefined
      try {
        const existing = await db.get(GC_CHECKPOINT_DOC) as { _rev?: string }
        rev = existing?._rev
      } catch (err) {
        if (!isNotFoundError(err)) throw err
        rev = undefined
      }
      try {
        await db.insert(
          { _id: GC_CHECKPOINT_DOC, ...(rev ? { _rev: rev } : {}), ...checkpoint } as never,
          GC_CHECKPOINT_DOC,
        )
      } catch (err) {
        // 并发 GC（多实例/人工脚本同时跑）时可能撞 409：进度落后一轮没关系，下一轮会重扫
        if (!isConflictError(err)) throw err
      }
    },

    async scanChanges(since, limit) {
      const response = await db.changes({
        since: (since ?? 0) as never,
        limit,
        style: "all_docs",
        include_docs: false,
      }) as unknown as {
        results?: Array<{ id?: string, deleted?: boolean, changes?: Array<{ rev?: string }> }>
        last_seq?: string | number
      }
      const results = response?.results ?? []
      const candidates = deletedTombstoneCandidates(results)
      return {
        candidates,
        rows: results.length,
        nextSince: response?.last_seq ?? since,
        // limit 是"最多返回这么多"，刚好等于 limit 说明可能还有下一页
        hasMore: results.length >= limit,
      }
    },

    async purge(candidates) {
      if (candidates.length === 0) return { purged: 0, requested: 0 }
      const body: Record<string, string[]> = {}
      for (const candidate of candidates) {
        (body[candidate.docId] ??= []).push(candidate.rev)
      }
      const response = await nanoServer.request({
        path: `${dbName}/_purge`,
        method: "POST",
        body,
      }) as { purged?: Record<string, string[]> }
      const purgedMap = response?.purged ?? {}
      let purged = 0
      for (const candidate of candidates) {
        if (Array.isArray(purgedMap[candidate.docId])
          && purgedMap[candidate.docId]!.includes(candidate.rev)) {
          purged += 1
        }
      }
      return { purged, requested: candidates.length }
    },

    async compact() {
      // 202 = 已受理，异步跑；GC 不等待完成（否则一个库能把一轮 GC 拖几分钟）
      await db.compact()
    },

    async tombstoneCount() {
      const info = await db.info() as { doc_del_count?: number }
      return typeof info?.doc_del_count === "number" ? info.doc_del_count : 0
    },
  }
}

function isConflictError(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode
  return status === 409
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode
  return status === 404
}
