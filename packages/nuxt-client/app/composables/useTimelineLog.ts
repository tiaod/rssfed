import { computed, ref } from 'vue'
import type { TimelineEvent, TimelineHeartbeat, TimelineSourceState } from '~/types/timeline-log'

/**
 * 同步日志（设置弹窗 → 数据 →「同步日志」）。
 *
 * 这里**不做轮询**：排查时按需点「刷新」即可，常驻轮询会把一个纯调试面板变成额外的
 * 后台请求源（设置弹窗本身也是低频入口）。展开时拉一次。
 *
 * 两段数据来自两个地方，这是有意分开的：
 *   - 轮次流水与心跳：服务端 PG（`/api/timeline/events`），晚一轮出现；
 *   - 各源当前状态：用户自己的库（`_local/schedule` → 订阅列表接口），实时。
 */
export function useTimelineLog() {
  const api = useApi()

  const events = ref<TimelineEvent[]>([])
  const sources = ref<TimelineSourceState[]>([])
  /** 抓取心跳（最近一轮时刻 / 连续空转轮数）；没跑过时是 null */
  const heartbeat = ref<TimelineHeartbeat | null>(null)
  /** 是否成功拉到过（决定显示「查看」按钮还是列表） */
  const loaded = ref(false)
  const loading = ref(false)
  const clearing = ref(false)
  const error = ref<string | null>(null)
  /** 当前拉取条数；「加载更多」就是把它翻倍后重拉 */
  const limit = ref(120)

  /**
   * 各源当前状态（读用户自己的库）。
   *
   * 失败不影响面板主体：订阅列表读不到时保留上一次的名单，流水照常显示。
   */
  async function loadSources(): Promise<void> {
    try {
      const remote = await api.feeds.subscriptions()
      sources.value = remote.map(item => ({
        feedId: item.feedId,
        title: item.title,
        status: item.status,
        lastFetchedAt: item.lastFetchedAt,
        errorMessage: item.errorMessage
      }))
    } catch {
      // 离线：保留旧名单，面板不会因此整块空掉
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [res] = await Promise.all([
        api.timeline.events(limit.value),
        loadSources()
      ])
      events.value = res.events ?? []
      heartbeat.value = res.heartbeat ?? null
      loaded.value = true
      error.value = null
    } catch (e: unknown) {
      error.value = errorMessage(e, '读取同步日志失败')
    } finally {
      loading.value = false
    }
  }

  /** 翻倍重拉（服务端最多 500 条，翻到头就停） */
  async function loadMore(): Promise<void> {
    if (limit.value >= 500) return
    limit.value = Math.min(500, limit.value * 2)
    await load()
  }

  const canLoadMore = computed(() => limit.value < 500 && events.value.length >= limit.value)

  async function clear(): Promise<void> {
    clearing.value = true
    try {
      await api.timeline.clearEvents()
      events.value = []
      loaded.value = true
      error.value = null
    } catch (e: unknown) {
      error.value = errorMessage(e, '清空同步日志失败')
    } finally {
      clearing.value = false
    }
  }

  return {
    events, sources, heartbeat,
    loaded, loading, clearing, error, limit, canLoadMore,
    load, loadMore, clear, loadSources
  }
}
