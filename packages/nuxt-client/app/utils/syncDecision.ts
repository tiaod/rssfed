import type { FeedSubscriptionItem } from '~/types/rss'

/** 同步水位表：feedId → 该源上次同步完成时间（ISO 串），持久化在 localStorage */
export type SyncedMap = Record<string, string>

/**
 * 判断某个源是否需要同步：从未同步过（首次/新订阅）或上次同步后有过新内容。
 *
 * 服务器从未抓到过新条目（lastNewEntryAt 缺失）的源没有可拉取的内容，直接跳过 ——
 * 因此调用方不要把「无法判断」（离线取不到列表）误当成「没有新内容」，那种情况
 * 应当绕过本函数（见 pickFeedsNeedingSync）。
 */
export function needsSync(feedId: string, lastNewEntryAt: string | undefined, synced: SyncedMap): boolean {
  if (!lastNewEntryAt) return false
  const lastSynced = synced[feedId]
  if (!lastSynced) return true
  return lastNewEntryAt > lastSynced
}

/**
 * 从目标集合里挑出真正需要发起复制的 id。自动同步（进入时间线）与手动同步
 * （点同步按钮）共用这一套判断，保证两条路径行为一致。
 *
 * 降级规则：
 * - `remoteSubs` 为 null（离线 / 接口失败）：判断依据缺失，全部保留。此时复制仍由
 *   PouchDB checkpoint 兜底增量，只是省不掉请求，语义等同于改动前的行为。
 * - `userStateId`（用户状态库）：没有 lastNewEntryAt 概念，只要在目标集合里就保留
 *   （它承载已读/收藏/订阅关系，跨设备一致性依赖它）。
 * - 不在远端列表里的 id：fail-open 保留 —— 可能是本地刚订阅、尚未推送到服务端的源，
 *   此时按「需要同步」处理，避免把用户显式点击的目标静默吞掉。
 */
export function pickFeedsNeedingSync(
  ids: string[],
  remoteSubs: FeedSubscriptionItem[] | null,
  synced: SyncedMap,
  userStateId: string
): string[] {
  if (!remoteSubs) return [...ids]
  const lastNewEntryAtById = new Map(remoteSubs.map(s => [s.feedId, s.lastNewEntryAt]))
  return ids.filter((id) => {
    if (id === userStateId) return true
    if (!lastNewEntryAtById.has(id)) return true
    return needsSync(id, lastNewEntryAtById.get(id), synced)
  })
}
