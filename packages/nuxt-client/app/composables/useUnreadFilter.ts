import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import type { ScanCursor, ScanPage } from '~/composables/usePouchDb'

/** 未读扫描的一页（由 usePouchDb 的 scan*Page 提供，只合已读态、未 enrich） */
export type UnreadScanPage<C> = ScanPage<C>

export interface UnreadFilterOptions<C> {
  /** 原始列表快照：筛选关掉时直接用它，同时它的最新一条就是扫描上界 */
  entries: Ref<RssEntry[]> | ComputedRef<RssEntry[]>
  /** 原始列表还有没有更多（筛选关掉时用） */
  hasMore: () => boolean
  /** 原始列表加载下一页（筛选关掉时用） */
  grow: () => boolean | Promise<boolean>
  /** 按游标往下扫一页（usePouchDb 的 scanTimelinePage / scanFeedPage / scanGroupPage） */
  scan: (cursor: C | null, limit: number, notAfter: ScanCursor | null) => Promise<UnreadScanPage<C>>
  /** 只对要上屏的那批做 enrich（usePouchDb.enrichEntries） */
  enrich: (entries: RssEntry[]) => Promise<RssEntry[]>
  /** 每页扫多少行（默认 300） */
  scanBatch?: number
  /** 一轮最多扫多少行，扫满还没凑够就停、留给下一轮（默认 10000） */
  maxScan?: number
  /** 一轮想凑多少条未读上屏（默认 50，与列表的页大小一致） */
  target?: number
}

/**
 * 「只看未读」。
 *
 * **扫描与上屏是两条路径**（这是本模块的全部意义）：
 *   - 扫描：沿时间序按游标大批量走本地视图，只合已读态，**不做 enrich**（不取源元信息、
 *     不取封面附件、不建 blob URL）。扫到的行绝大多数会被丢掉，给它们付上屏成本纯属浪费。
 *   - 上屏：一轮只把凑够的那几十条 unread 交给 enrich，再交给 EntryList。
 *
 * 这样即使未读很少、要往下挖几千条，代价也只是「几千行投影 + 每批一次状态批量查询」，
 * 而不是几千次附件读取。用 `scanBatch`（默认 300）控制每批行数，`maxScan`（默认 10000）
 * 限制单轮总扫描量，避免一次点击卡住界面：扫满就停，列表给「继续扫描」。
 *
 * 扫描上界固定为**当前列表快照的最新一条**：列表是快照，同步进来的新条目要等用户点「查看」
 * 才该出现（见 useSyncedEntryList），扫描不能把它提前放出来。快照换了（点「查看」/首屏加载完）
 * 就重扫。
 *
 * 会话级状态（useState）：页面之间来回跳不丢，刷新即回到「显示全部」。切到别的模式会重置扫描
 * （读状态可能在别处变过），再打开时重新扫一遍。
 *
 * 正在弹窗里读的那一条，即使已被自动标为已读也继续留在列表里，否则它会当场消失、
 * 弹窗的「上一篇 / 下一篇」失去定位基准。
 */
export function useUnreadFilter<C = ScanCursor>(options: UnreadFilterOptions<C>) {
  const unreadOnly = useState<boolean>('entries-unread-only', () => false)
  const { isOpen, currentEntry } = useEntryModal()

  const scanBatch = options.scanBatch ?? 300
  const maxScan = options.maxScan ?? 10000
  const target = options.target ?? 50

  /** 扫描出来的未读条目（已 enrich、可直接上屏），按时间倒序 */
  const unreadEntries = ref<RssEntry[]>([])
  /** 已扫描的行数：空态里如实告诉用户「扫了多少条」 */
  const scannedCount = ref(0)
  /** 正在扫描（页面据此显示「正在扫描未读…」而不是「没有未读」） */
  const probing = ref(false)
  const unreadHasMore = ref(false)

  /** 续扫游标（对 composable 是不透明的，由 scan 回调解释） */
  let cursor: C | null = null
  /** 扫到但还没上屏的未读：一页可能扫出远超一屏，不能丢 */
  let pending: RssEntry[] = []
  let exhausted = false
  /** 代次：重置 / 换扫描上界时作废在途结果 */
  let generation = 0

  /** 扫描上界 = 原始快照的最新一条；快照为空时不设上界（从库头开始） */
  const notAfter = computed<ScanCursor | null>(() => {
    const head = options.entries.value[0]
    if (!head) return null
    const ms = Date.parse(head.publishedAt)
    return Number.isNaN(ms) ? null : { ms, id: head.id }
  })

  const visibleEntries = computed<RssEntry[]>(() => {
    if (!unreadOnly.value) return options.entries.value
    const openId = isOpen.value ? currentEntry.value?.id : undefined
    return unreadEntries.value.filter(entry => !entry.read || entry.id === openId)
  })

  /** 当前模式下还有没有更多（EntryList 的页尾骨架与尽头提示都看它） */
  function visibleHasMore(): boolean {
    return unreadOnly.value ? unreadHasMore.value : options.hasMore()
  }

  /** 丢掉扫描进度与结果（不改筛选开关本身） */
  function reset() {
    generation++
    unreadEntries.value = []
    scannedCount.value = 0
    unreadHasMore.value = false
    probing.value = false
    cursor = null
    pending = []
    exhausted = false
  }

  /** 扫描一轮：先消化上一轮的遗留，再往下扫，直到凑够 target 或触到本轮上限 */
  async function probeRound(): Promise<boolean> {
    if (!unreadOnly.value || probing.value || exhausted) return false
    const gen = ++generation
    probing.value = true
    const collected: RssEntry[] = []
    try {
      // ① 上一轮扫出来但没上屏的（进缓冲区之后可能已被别处标已读，重新确认一遍）
      while (pending.length && collected.length < target) {
        const row = pending.shift()!
        if (!row.read) collected.push(row)
      }

      // ② 沿游标往下扫
      let scannedThisRound = 0
      while (collected.length < target && !exhausted && scannedThisRound < maxScan) {
        const page = await options.scan(cursor, scanBatch, notAfter.value)
        if (gen !== generation) return false // 期间被重置：结果作废
        if (page.rows.length === 0) {
          exhausted = true
          break
        }
        cursor = page.cursor
        exhausted = page.exhausted
        scannedThisRound += page.rows.length
        scannedCount.value += page.rows.length
        for (const row of page.rows) {
          if (row.read) continue
          if (collected.length < target) collected.push(row)
          else pending.push(row)
        }
      }

      if (gen !== generation) return false
      if (collected.length) {
        const enriched = await options.enrich(collected)
        if (gen !== generation) return false
        unreadEntries.value = [...unreadEntries.value, ...enriched]
      }
      unreadHasMore.value = !exhausted || pending.length > 0
      return collected.length > 0
    } finally {
      if (gen === generation) probing.value = false
    }
  }

  /**
   * 无限滚动的入口：按当前模式分派。
   *
   * 未读模式**故意永远返回 true**：useInfiniteList 的 hasMore 是一旦 false 就永久闩死的闩，
   * 在未读扫描到尽头时闩死会把随后关掉筛选的原始列表一起闩死。「未读还有没有」由
   * visibleHasMore() 单独告诉 EntryList（它决定页尾骨架还是尽头提示）。
   */
  async function loadMoreVisible(): Promise<boolean> {
    if (!unreadOnly.value) return await options.grow()
    await probeRound()
    return true
  }

  function toggleUnreadOnly() {
    unreadOnly.value = !unreadOnly.value
    // 两种模式的数据不是同一批对象：切走时留下的未读列表可能已被别处标读，直接丢掉重扫
    reset()
    if (unreadOnly.value) void probeRound()
  }

  // 快照换了（用户点「查看」/首屏加载完成）→ 扫描上界变了，重扫一遍
  watch(() => options.entries.value[0]?.id ?? '', () => {
    if (!unreadOnly.value) return
    reset()
    void probeRound()
  })

  return {
    unreadOnly,
    visibleEntries,
    visibleHasMore,
    loadMoreVisible,
    toggleUnreadOnly,
    /** 正在扫描未读 */
    probing,
    /** 本轮已扫描的行数（空态文案用） */
    scannedCount
  }
}
