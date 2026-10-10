import { computed } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'
import { useManualSync } from '~/composables/useManualSync'
import type { ManualSyncOutcome } from '~/composables/useManualSync'

/**
 * 「同步 / 刷新订阅」这一个动作的状态与文案。
 *
 * 抽出来是因为它现在有两个门面：首页导航栏仍是 `SyncButton`，四个列表页把同步收进了「三个点」
 * 菜单（菜单项与触发按钮都要同样的转圈 / 失败变红 / 「上次同步：x 分钟前」）。
 * 两处各写一份的话，文案和判据迟早会漂移。
 *
 * `syncing` 只表示**手动**同步进行中：live 同步的状态只驱动全局进度条，否则初始同步因连接
 * 竞争卡住时按钮会一直禁用，用户反而没法重试。
 *
 * 状态取自 syncStatuses 的全部条目：服务端聚合之后同步目标只有时间线库与用户状态库两个，
 * 调用方（各列表页）不再需要、也无法按「本页涉及哪些源」来切分同步状态。
 */
export function useSyncAction() {
  const pouch = usePouchDb()

  /** 相关库的 id 集合（= 当前有同步状态的全部目标） */
  const relatedIds = computed(() => Object.keys(pouch.syncStatuses))

  // 手动同步逻辑与侧边栏的状态指示器共用（toast 文案只有一处）
  const { syncing, sync } = useManualSync()

  const hasError = computed(() =>
    relatedIds.value.some(id => pouch.syncStatuses[id]?.status === 'error')
  )

  const errorDetail = computed(() => {
    const err = relatedIds.value
      .map(id => pouch.syncStatuses[id]?.error)
      .find(Boolean)
    return err ?? '同步失败，请重试'
  })

  // 相关库中最近一次同步时间（取最早的那个）
  const lastSyncedAt = computed(() => {
    const times = relatedIds.value
      .map(id => pouch.syncStatuses[id]?.lastSyncedAt)
      .filter((t): t is string => !!t)
    if (!times.length) return null
    return times.reduce((min, t) => (t < min ? t : min))
  })

  /** 相对时间展示：1 分钟内「刚刚」，1 小时内「x 分钟前」，更早显示时分 */
  function formatRelativeTime(iso: string) {
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin} 分钟前`
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  /** 同步状态文案（菜单项的 description / 按钮的 tooltip 共用）；没有可说的返回 null */
  const statusText = computed(() => {
    if (syncing.value) return '同步中…'
    if (hasError.value) return errorDetail.value
    if (lastSyncedAt.value) return `上次同步：${formatRelativeTime(lastSyncedAt.value)}`
    return null
  })

  const tooltipText = computed(() => statusText.value ?? '同步')

  /**
   * 触发同步；重入（上一轮还在跑）时返回 null，调用方据此知道本轮没真的执行。
   *
   * `scope` 是**反馈口径**：列表页传自己列表的 feedId，toast 与 outcome.added 就报这个列表
   * 多了几条；不传（侧边栏那种全局同步）报全库。聚合范围与此无关，永远是全部订阅。
   */
  async function runSync(scope?: readonly string[]): Promise<ManualSyncOutcome | null> {
    return await sync(scope)
  }

  return { syncing, hasError, errorDetail, statusText, tooltipText, sync: runSync }
}
