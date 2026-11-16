import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTimelineCloudInfo } from '~/composables/useTimelineCloudInfo'
import { useTimelineLog } from '~/composables/useTimelineLog'
import { formatBytes, useStorageEstimate } from '~/composables/useStorageEstimate'
import { formatSyncedAt, summarizeSyncStatuses, syncStatusLabel } from '~/utils/syncStatusSummary'
import { summarizeReading, type ReadingDigest } from '~/utils/readingStats'

/**
 * 时间线右栏两张卡的数据。
 *
 * 拆成两部分是有意的：
 *   - 同步健康：全是**现成**的数据源（本地同步状态、云端库体积、服务端水位表），组件只负责排版；
 *   - 阅读小结：本地状态文档的一次全量扫描 + 纯函数汇总（见 utils/readingStats）。
 *
 * 都不新增后端接口：右栏是「顺手看一眼」的位置，为它加轮询或新端点不划算。
 * 因此这里也**不做定时刷新** —— 触发点只有挂载、窗口重新可见、以及状态/同步版本变化。
 */

/** 同步健康里「哪些源有问题」的明细行，最多列这么多（再多就不适合放在侧栏了） */
const MAX_PROBLEM_SOURCES = 3

export function useTimelineSidebar() {
  const pouch = usePouchDb()
  const cloudInfo = useTimelineCloudInfo()
  const storageEstimate = useStorageEstimate()
  const timelineLog = useTimelineLog()

  // ── 时钟：相对文案不能只在挂载时算一次 ──

  /**
   * 每分钟推进一次的「现在」。
   *
   * 「3 分钟前」这类文案如果只在挂载时算，页面开着半小时也不会变；定时器只在侧栏挂载期间跑，
   * 页面切走就停（见 onBeforeUnmount）。用分钟粒度而不是秒：这里没有倒计时需要秒级同步。
   */
  const clockNow = ref(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null

  function startClock() {
    stopClock()
    clockNow.value = Date.now()
    clockTimer = setInterval(() => {
      clockNow.value = Date.now()
    }, 60_000)
  }

  function stopClock() {
    if (clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }

  // ── 同步健康 ──

  const syncSummary = computed(() => summarizeSyncStatuses(pouch.syncStatuses, {
    paused: pouch.paused.value,
    storageError: pouch.storageBroken.value
  }))

  const syncLabel = computed(() => syncStatusLabel(syncSummary.value.state))

  /**
   * 「上次同步」两种口径都取到：本地复制的 lastSyncedAt（实时、精确到这台机器）
   * 与服务端水位表（另一台设备/后台聚合的结果）。
   *
   * 侧栏要回答的是「内容还新不新」，本地那个更贴近「我这台机器上看到的是什么时候的」；
   * 但刚打开的机器可能还没有本地记录，此时服务端水位表能顶上。取两者里较新的那个。
   */
  const lastSyncedAt = computed(() => {
    const local = syncSummary.value.lastSyncedAt
    const remote = timelineLog.sources.value
      .map(s => s.syncedAt)
      .filter((t): t is string => !!t)
      .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null)
    if (!local) return remote
    if (!remote) return local
    return local > remote ? local : remote
  })

  /** 「3 分钟前」这类相对文案。用同一个 now 重算，避免每行各取一次时间导致前后矛盾 */
  const lastSyncedText = computed(() => {
    const at = lastSyncedAt.value
    return at ? formatSyncedAt(at, clockNow.value) : '还没有记录'
  })

  /** 云端库体积：`云端 797 MB · 4965 条`；拿不到体积时只说条数 */
  const cloudText = computed(() => {
    const info = cloudInfo.info.value
    if (!info) return ''
    const size = info.externalSize !== null ? formatBytes(info.externalSize) : ''
    return size ? `${size} · ${info.docCount} 条` : `${info.docCount} 条`
  })

  /**
   * 本站缓存占用（口径是**整个站点**，见 useStorageEstimate 头注释）。
   *
   * usage 为 0 时不显示：浏览器在某些场景（无痕 / 刚清过缓存 / 估算被裁剪）会稳定返回 0，
   * 而「0 B」是个会被当成事实的错误数字 —— 少一行比显示一个假数字好。
   */
  const localText = computed(() => {
    const usage = storageEstimate.info.value?.usage ?? 0
    if (!storageEstimate.supported.value || usage <= 0) return ''
    return formatBytes(usage)
  })

  /**
   * 有问题的源：状态是 error、或最后同步失败过的。
   *
   * 这是这张卡真正的价值 —— 汇总数字（几个源、多久前）在别处也能看到，而「哪个源悄悄死了」
   * 只有服务端的源水位表知道。只列前 MAX_PROBLEM_SOURCES 条，剩下的折成一句「另有 N 个」。
   */
  const problemSources = computed(() => {
    const bad = timelineLog.sources.value
      .filter(s => s.status === 'error' || !!s.lastError)
      .map(s => ({ id: s.sourceId, title: s.title || '（已删除的订阅源）' }))
    return { items: bad.slice(0, MAX_PROBLEM_SOURCES), more: Math.max(0, bad.length - MAX_PROBLEM_SOURCES) }
  })

  /** 订阅源总数：本地订阅（含 bot）比服务端水位表更贴近用户认知，优先用它 */
  const feedCount = ref(0)

  async function refreshFeeds() {
    try {
      feedCount.value = (await pouch.listSubscriptions()).length
    } catch {
      // 订阅读不到时保持 0：卡片上不显示这一项，而不是显示「0 个源」
    }
  }

  // ── 阅读小结 ──

  const emptyDigest = (): ReadingDigest => ({ today: 0, week: 0, total: 0, saved: 0, savedUnread: 0 })
  const digest = ref<ReadingDigest>(emptyDigest())
  /** 是否成功算过一轮（false 时卡片显示占位，而不是一排 0） */
  const digestLoaded = ref(false)

  async function refreshDigest() {
    try {
      digest.value = summarizeReading(await pouch.queryEntryStates())
      digestLoaded.value = true
    } catch {
      // 小结是辅助信息：读失败就保持上一次的数字，不要把卡片变成错误块
    }
  }

  /** 一次把两张卡的数据都刷了（挂载、窗口重新可见时调） */
  async function refreshAll() {
    await Promise.all([
      refreshFeeds(),
      refreshDigest(),
      cloudInfo.refresh(),
      storageEstimate.refresh(),
      // 源水位表：同步健康卡靠它说「哪个源失败了」。失败不该让整张卡空掉，load 内部已兜底
      timelineLog.load()
    ])
  }

  onMounted(() => {
    startClock()
    void refreshAll()
    if (import.meta.client) document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onBeforeUnmount(() => {
    stopClock()
    if (import.meta.client) document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  /**
   * 切回这个标签页时补一次。
   *
   * 后台标签页的定时器会被浏览器节流甚至冻结，回来时「3 分钟前」可能停在半小时前的数字上；
   * 顺手也把服务端水位表重读一遍（前台时同步多半已经推进过了）。
   */
  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return
    clockNow.value = Date.now()
    void timelineLog.load()
    void refreshDigest()
    void cloudInfo.refresh()
  }

  // 状态文档变化（本地标记 / 别处读完同步过来）就重算小结。防抖是必须的：
  // 「全部标记为已读」会一次性写几十条，每条都触发一次全量 allDocs 会把状态库打满。
  let digestTimer: ReturnType<typeof setTimeout> | null = null
  watch(pouch.stateVersion, () => {
    if (digestTimer) clearTimeout(digestTimer)
    digestTimer = setTimeout(() => {
      digestTimer = null
      void refreshDigest()
    }, 300)
  })

  // 同步状态变化时重读云端体积：内容刚搬完，条数与体积都变了（refresh 内部有 60s 缓存）
  watch(pouch.timelineVersion, () => {
    void cloudInfo.refresh()
  })
  // 订阅增减会影响「N 个源」
  watch(pouch.subscriptionsVersion, () => {
    void refreshFeeds()
  })

  return {
    // 同步健康
    syncState: computed(() => syncSummary.value.state),
    syncLabel,
    lastSyncedText,
    cloudText,
    localText,
    problemSources,
    feedCount,
    logLoading: computed(() => timelineLog.loading.value),
    refreshAll,
    // 阅读小结
    digest,
    digestLoaded,
    // 让组件把「现在」也用在别处（如自定义相对时间）时不必再起一个定时器
    now: clockNow
  }
}
