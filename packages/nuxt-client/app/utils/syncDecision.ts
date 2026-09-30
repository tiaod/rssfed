import type { FeedSubscriptionItem } from '~/types/rss'

/**
 * 单源同步水位记录（v2）。
 *
 * `seen` 记录「上次成功同步时，服务端该源的 lastNewEntryAt 值」，增量判断直接比这个值：
 * 两者都是服务端写的时间戳，来自同一个时钟，不存在「服务端时钟 vs 浏览器时钟」的偏差问题。
 */
export interface FeedSyncMark {
  /** 上次成功同步完成时间（本地时钟，仅用于展示与诊断） */
  at: string
  /** 上次成功同步时看到的服务端 lastNewEntryAt；缺失表示由 v1 旧记录迁移而来 */
  seen?: string
}

/**
 * 同步水位表：feedId → 水位记录，持久化在 localStorage。
 *
 * 兼容 v1：旧记录的值是 ISO 字符串（只有本地同步时间），读取时按 `{ at }` 处理，
 * 判定退化为时间比较；下次同步成功后会写回带 `seen` 的 v2 记录。
 */
export type SyncedMap = Record<string, string | FeedSyncMark>

/** 单个源的失败退避记录 */
export interface SyncRetryMark {
  /** 连续失败次数（成功后清零） */
  attempts: number
  /** 最近一次失败的尝试时间（ISO） */
  lastAttemptAt: string
}

/** 失败退避表：feedId → 退避记录，持久化在 localStorage */
export type RetryMap = Record<string, SyncRetryMark>

/** 退避起点：首次失败后 30s 内不再重试 */
export const RETRY_BASE_MS = 30_000
/** 退避上限：连续失败后最多 10 分钟重试一次 */
export const RETRY_MAX_MS = 10 * 60_000

/** 第 n 次失败后的退避时长（指数退避，封顶 RETRY_MAX_MS） */
export function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
}

/** 规范化水位记录：兼容 v1 的纯 ISO 字符串 */
export function normalizeMark(mark: string | FeedSyncMark | undefined): FeedSyncMark | null {
  if (!mark) return null
  return typeof mark === 'string' ? { at: mark } : mark
}

/** 是否仍处于失败退避窗口内（窗口内不再对同一源发起复制） */
export function inRetryBackoff(feedId: string, retry: RetryMap, now: number = Date.now()): boolean {
  const mark = retry[feedId]
  if (!mark || mark.attempts <= 0) return false
  const last = Date.parse(mark.lastAttemptAt)
  if (!Number.isFinite(last)) return false
  return now - last < retryBackoffMs(mark.attempts)
}

/**
 * 判断某个源是否需要同步。
 *
 * 规则（按顺序）：
 *   1. 服务端从未抓到过新条目（`lastNewEntryAt` 缺失）→ 不同步，没有可拉取的内容；
 *   2. 上次尝试失败且还在退避窗口内 → 本轮跳过（避免几百个失败源每轮全量重试）；
 *   3. 从未成功同步过（无水位记录）→ 同步；
 *   4. 记录里有 `seen` → `lastNewEntryAt` 与服务端上次看到的值不同即同步（同一时钟，无偏差）；
 *   5. 只有 v1 的本地时间 → 退化为时间比较。
 *
 * 调用方不要把「无法判断」（离线取不到列表）误当成「没有新内容」，那种情况应绕过本函数
 * （见 pickFeedsNeedingSync）。
 */
export function needsSync(
  feedId: string,
  lastNewEntryAt: string | undefined,
  synced: SyncedMap,
  retry: RetryMap = {},
  now: number = Date.now()
): boolean {
  if (!lastNewEntryAt) return false
  if (inRetryBackoff(feedId, retry, now)) return false
  const mark = normalizeMark(synced[feedId])
  if (!mark) return true
  if (mark.seen !== undefined) return lastNewEntryAt !== mark.seen
  return lastNewEntryAt > mark.at
}

/**
 * 从目标集合里挑出真正需要发起复制的 id。自动同步（进入时间线）与手动同步
 * （点同步按钮）共用这一套判断，保证两条路径行为一致。
 *
 * 降级规则：
 * - `remoteSubs` 为 null（离线 / 接口失败）：判断依据缺失，全部保留。此时复制仍由
 *   PouchDB checkpoint 兜底增量，只是省不掉请求，语义等同于改动前的行为。
 * - `userStateId`（用户状态库）：没有 lastNewEntryAt 概念，只要在目标集合里就保留
 *   （它承载已读/收藏/订阅关系，跨设备一致性依赖它），且不受失败退避限制。
 * - 不在远端列表里的 id：fail-open 保留 —— 可能是本地刚订阅、尚未推送到服务端的源，
 *   此时按「需要同步」处理，避免把用户显式点击的目标静默吞掉。
 */
export function pickFeedsNeedingSync(
  ids: string[],
  remoteSubs: FeedSubscriptionItem[] | null,
  synced: SyncedMap,
  userStateId: string,
  retry: RetryMap = {},
  now: number = Date.now()
): string[] {
  if (!remoteSubs) return [...ids]
  const lastNewEntryAtById = new Map(remoteSubs.map(s => [s.feedId, s.lastNewEntryAt]))
  return ids.filter((id) => {
    if (id === userStateId) return true
    if (!lastNewEntryAtById.has(id)) return true
    return needsSync(id, lastNewEntryAtById.get(id), synced, retry, now)
  })
}

/**
 * 是否为「本地存储故障」：IndexedDB 配额耗尽、数据库进入 global failure 等。
 *
 * PouchDB 在这类故障下抛出的错误形状不统一：
 *   - 首个错误是 `{ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' }`；
 *   - 之后同一库上的操作会以 `new Error('')`（message 为空）立即失败。
 * 因此只要命中一次就要熔断本轮同步：继续跑只会把剩余任务全部快速失败掉，
 * 既写不进数据也不记水位，下一轮还得全量重来。
 */
export function isStorageFailure(e: unknown): boolean {
  if (!e) return false
  const err = e as { name?: unknown, reason?: unknown, message?: unknown, status?: unknown }
  const name = typeof err.name === 'string' ? err.name : ''
  const reason = typeof err.reason === 'string' ? err.reason : ''
  const message = typeof err.message === 'string' ? err.message : ''
  if (name === 'indexed_db_went_bad' || name === 'QuotaExceededError') return true
  if (/QuotaExceededError/i.test(reason)) return true
  if (/global failure|indexed_db_went_bad|QuotaExceededError/i.test(message)) return true
  return false
}
