import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import type { ScanCursor, ScanPage } from '~/composables/usePouchDb'
import { scrollListToTop } from '~/utils/scrollContainer'

/** 未读扫描的一页（由 usePouchDb 的 scan*Page 提供，只合已读态、不 enrich） */
export type UnreadScanPage<C> = ScanPage<C>

export interface UnreadFilterOptions<C> {
  /** 原始列表快照：筛选关掉时直接用它 */
  entries: Ref<RssEntry[]> | ComputedRef<RssEntry[]>
  /** 原始列表还有没有更多（筛选关掉时用） */
  hasMore: () => boolean
  /** 原始列表加载下一页（筛选关掉时用） */
  grow: () => boolean | Promise<boolean>
  /** 按游标往下扫一页（usePouchDb 的 scanTimelinePage / scanFeedPage / scanGroupPage） */
  scan: (cursor: C | null, limit: number) => Promise<UnreadScanPage<C>>
  /** 只对要上屏的那批做 enrich（usePouchDb.enrichEntries） */
  enrich: (entries: RssEntry[]) => Promise<RssEntry[]>
  /**
   * 列表顶部锚点（页面传 useSyncedEntryList 的 listAnchorRef）：
   * `refreshUnread()` 重新扫完之后据此找到滚动容器并回到顶部 —— 列表整体换了一批，
   * 停在原来的滚动位置没有意义。
   */
  anchor?: () => HTMLElement | null
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
 * **切进「只看未读」= 一次完整刷新**：扫描不受列表快照约束（从本地库最新一条往下走），
 * 同步刚写进来、还没点「查看」的条目同样在范围内。列表那边仍是快照语义（见
 * useSyncedEntryList）—— 两套语义各自成立：快照保证「同步不推走正在读的内容」，
 * 而用户主动切模式本来就要换一批数据看，此时给他最新的才符合直觉。
 * 也正因如此，「已同步 N 条」提示条在未读模式下整条收起（见 useEntriesBannerVisibility
 * 的 `suppressed`），计数不清零，切回全部时照旧出现。
 *
 * **上屏的这批同样是快照：读过的条目不会自己消失**（这是本模块最容易被改错的一处）。
 * 早先的实现在 `visibleEntries` 里实时按 `!entry.read` 过滤，于是打开详情的那一下
 * 「打开即已读」就把这一条当场抽走，用户还在读、列表已经空出一格，关掉弹窗连自己读到哪儿
 * 都找不到。现在的口径：
 *   - 标记已读只让这一条淡显（与「显示全部」下完全一样），**留在原位**；
 *   - 只有 `refreshUnread()`（动作区 ⋮ 菜单里的「刷新未读列表」）才真正移出，
 *     同时重新从库头扫一批最新的未读上来（同步新到的也在内）并回到顶部；
 *   - 「全部标记为已读」是明确的「这批我看完了」，标完当场走同一条刷新路径（见
 *     useMarkAllRead 的 afterMark），不必再点一次刷新。
 * 这样一来也不需要「正在读的那条即使已读也留着」这条特例了 —— 谁也不走。
 *
 * 会话级状态（useState）：页面之间来回跳不丢，刷新即回到「显示全部」。切到别的模式会重置扫描
 * （读状态可能在别处变过），再打开时重新扫一遍。
 */
export function useUnreadFilter<C = ScanCursor>(options: UnreadFilterOptions<C>) {
  const unreadOnly = useState<boolean>('entries-unread-only', () => false)

  const scanBatch = options.scanBatch ?? 300
  const maxScan = options.maxScan ?? 10000
  const target = options.target ?? 50

  /** 扫描出来的未读条目（已 enrich、可直接上屏），按时间倒序；进来时是什么就是什么，不随已读态增删 */
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
  /** 代次：重置时作废在途结果 */
  let generation = 0

  /**
   * 上屏的这批里已经有几条被标为已读（还没移出）。
   *
   * 只用来在刷新入口上如实报数（「移出 N 条已读」），不参与过滤 —— 一旦拿它去过滤，
   * 就又回到「读完当场消失」的老路上了。
   */
  const staleCount = computed(() => unreadEntries.value.reduce((n, entry) => n + (entry.read ? 1 : 0), 0))

  const visibleEntries = computed<RssEntry[]>(() => {
    if (!unreadOnly.value) return options.entries.value
    return unreadEntries.value
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

  /**
   * 扫一轮：先消化上一轮的遗留，再往下扫，直到凑够 target 或触到本轮上限。
   *
   * `mode` 决定结果怎么落到列表上：
   *   - `append`：接着上次的游标往下补（无限滚动）；
   *   - `replace`：从库头重扫，整体换掉列表（刷新）。
   *
   * 刷新期间**旧列表继续显示**，新结果落地才替换：否则点一下刷新会先白一下再长回来。
   * 游标 / 缓冲区 / 「已到底」的结论也是落地时才一起推进 —— 中途被重置（代次变了）的那一轮
   * 不能把半截状态留在现场。
   */
  async function scanRound(mode: 'append' | 'replace'): Promise<boolean> {
    if (!unreadOnly.value || probing.value) return false
    if (mode === 'append' && exhausted) return false

    const gen = ++generation
    probing.value = true

    let nextCursor: C | null = mode === 'replace' ? null : cursor
    const nextPending: RssEntry[] = mode === 'replace' ? [] : pending.slice()
    let nextExhausted = mode === 'replace' ? false : exhausted
    let scanned = 0
    const collected: RssEntry[] = []

    try {
      // ① 上一轮扫出来但没上屏的（进缓冲区之后可能已被别处标已读，重新确认一遍）
      while (nextPending.length && collected.length < target) {
        const row = nextPending.shift()!
        if (!row.read) collected.push(row)
      }

      // ② 沿游标往下扫
      while (collected.length < target && !nextExhausted && scanned < maxScan) {
        const page = await options.scan(nextCursor, scanBatch)
        if (gen !== generation) return false // 期间被重置：结果作废
        if (page.rows.length === 0) {
          nextExhausted = true
          break
        }
        nextCursor = page.cursor
        nextExhausted = page.exhausted
        scanned += page.rows.length
        for (const row of page.rows) {
          if (row.read) continue
          if (collected.length < target) collected.push(row)
          else nextPending.push(row)
        }
      }

      if (gen !== generation) return false
      const enriched = collected.length ? await options.enrich(collected) : []
      if (gen !== generation) return false

      // 结果有效才落地：游标、缓冲区、条目一起换
      cursor = nextCursor
      pending = nextPending
      exhausted = nextExhausted
      scannedCount.value = mode === 'replace' ? scanned : scannedCount.value + scanned
      unreadEntries.value = mode === 'replace' ? enriched : [...unreadEntries.value, ...enriched]
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
    await scanRound('append')
    return true
  }

  /**
   * 刷新未读列表：把已经读过的那批移出，重新从库头扫一批最新的未读上来，并回到顶部。
   *
   * 这是**唯一**会让已读条目离开列表的动作（另一个入口是「全部标记为已读」，它标完直接
   * 调这里）。扫描期间旧列表照旧显示，落地才替换。
   *
   * 刷新**接管**在途的那一轮扫描（比如用户正滚到底、续扫还没回来）：作废它，而不是安静地
   * 什么都不做 —— 点了没反应比慢一点更糟。被作废的那一轮在 gen 检查处自行退出，
   * 不会把半截结果或游标留在现场。
   */
  async function refreshUnread(): Promise<boolean> {
    if (!unreadOnly.value) return false
    if (probing.value) {
      generation++
      probing.value = false
    }
    const got = await scanRound('replace')
    scrollListToTop(options.anchor?.() ?? null)
    return got
  }

  function toggleUnreadOnly() {
    unreadOnly.value = !unreadOnly.value
    // 两种模式的数据不是同一批对象：切走时留下的未读列表可能已被别处标读，直接丢掉重扫。
    // 打开的这一下就是一次完整刷新（不受列表快照约束），用户看到的一定是当下最新的未读。
    reset()
    if (unreadOnly.value) void scanRound('append')
  }

  // 页面（重新）挂载后补扫：开关是会话级（useState），页面往返不会关掉它，但扫描结果
  // （unreadEntries / 游标 / 缓冲区）是组件实例本地的，卸载即丢。重新挂载时若已经处在未读
  // 模式，必须补扫一轮，否则列表为空，空态会误报「这个列表里没有未读条目」。
  //
  // 由页面在 scan 回调可用的时机调用，不在 setup 里自动跑：分组页的扫描范围依赖订阅列表，
  // 那时 feedIds 还是空的，扫出来的「已到底」是假结论。
  function resumeUnreadScan() {
    if (unreadOnly.value) void scanRound('append')
  }

  return {
    unreadOnly,
    visibleEntries,
    visibleHasMore,
    loadMoreVisible,
    resumeUnreadScan,
    refreshUnread,
    toggleUnreadOnly,
    /** 正在扫描未读 */
    probing,
    /** 本轮已扫描的行数（空态文案用） */
    scannedCount,
    /** 上屏的这批里有几条已经读过、下次刷新会移出（刷新入口据此报数） */
    staleCount
  }
}
