import type { RssEntry } from '~/types/rss'

export interface UseSyncedEntryListOptions {
  /** 按窗口大小查询本地集中库（时间线 / 单源 / 分组 / bot 产出各不同） */
  query: (limit: number) => Promise<RssEntry[]>
  /** 每页条数（无限滚动步长） */
  pageSize?: number
  /** 查询窗口上限，达到后不再加载 */
  maxEntries?: number
  /**
   * 本列表范围内「已同步写入的文档数」的当前值（单调递增，来自复制任务的 change 事件）。
   *
   * 页面从 usePouchDb 的 syncedDocsByFeed 按自己的订阅源求和传进来；比上次查看时多出来的
   * 部分就是待查看的新条目数，显示成「已同步 N 条」提示条。不传则不显示提示条。
   */
  syncedDocs?: () => number
}

/**
 * 条目列表的数据源与刷新策略。
 *
 * 只有一条规则：**列表是一份快照，只在 `load()` 里整体替换**。
 *
 *   - 同步（无论后台还是手动）只报数，不碰列表：把新写入的条数累计成提示条；
 *   - 用户点提示条 → `applyNew()` → 重新查一次本地库，整体换成最新，回到顶部；
 *   - 无限滚动 `grow()` 只把「当前列表最后一条之后」的旧条目接到末尾，不重排已显示内容。
 *
 * 这样就不会出现「可见列表」和「待上屏内容」两份互相不一致的数据——之前那套按 id 前缀
 * 推断「头部是否新增」再决定折叠/静默上屏的状态机，是这个模块绝大多数 bug 的来源。
 */
export function useSyncedEntryList(options: UseSyncedEntryListOptions) {
  const pageSize = options.pageSize ?? 50
  const maxEntries = options.maxEntries ?? 10000

  const entries = ref<RssEntry[]>([])
  /** 查询窗口：无限滚动逐步增大；点提示条刷新时保留当前深度（用户翻到第几页不丢） */
  const displayLimit = ref(pageSize)
  const hasMore = ref(true)
  /** 待查看的新条目数（0 表示提示条收起） */
  const newCount = ref(0)
  /** 列表顶部锚点：应用更新时据此找到滚动容器并回顶 */
  const listAnchorRef = ref<HTMLElement | null>(null)

  /** 在途查询的代次：并发重查时只认最后一次，避免旧窗口结果覆盖新结果 */
  let generation = 0

  /** 本列表范围内已同步写入的文档数 */
  function syncedDocs(): number {
    return options.syncedDocs ? options.syncedDocs() : 0
  }

  /** 上次「列表里显示的就是最新内容」时的同步计数：与当前值之差即待查看条数 */
  let seenDocs = syncedDocs()

  /** 查询窗口；期间又发起了新查询时返回 null 表示本次结果作废 */
  async function queryWindow(limit: number): Promise<RssEntry[] | null> {
    const gen = ++generation
    const list = await options.query(limit)
    return gen === generation ? list : null
  }

  /** 列表里显示的就是已同步的最新内容：计数归零，提示条收起 */
  function markSeen() {
    seenDocs = syncedDocs()
    newCount.value = 0
  }

  /** 查一次当前窗口并整体替换列表（首屏与用户点「查看」都走这里） */
  async function load(): Promise<void> {
    const next = await queryWindow(displayLimit.value)
    if (!next) return
    // 查询异常时本地查询会返回空数组（见 usePouchDb.queryByView 的 catch）。
    // 已经读到内容的情况下不拿空结果把列表清空，避免一次查询抖动就白屏。
    if (next.length === 0 && entries.value.length > 0) return
    entries.value = next
    hasMore.value = next.length >= displayLimit.value && displayLimit.value < maxEntries
    markSeen()
  }

  /**
   * 无限滚动：窗口 +1 页，只把「当前列表最后一条之后」的旧条目接到末尾。
   *
   * 不做整体替换：窗口变大后查询结果的头部会带上这期间同步进来的新条目，整体替换会把
   * 用户正在读的内容往下推。头部的新条目已经计进 newCount，仍由提示条负责。
   */
  async function grow(): Promise<boolean> {
    if (!hasMore.value) return false
    const limit = Math.min(displayLimit.value + pageSize, maxEntries)
    const next = await queryWindow(limit)
    if (!next) return hasMore.value
    displayLimit.value = limit

    const known = new Set(entries.value.map(e => e.id))
    // 当前列表最后一条在查询结果中的位置：排在它之后的才是「更旧的」尾部扩展
    let lastKnown = -1
    for (let i = 0; i < next.length; i++) {
      if (known.has(next[i]!.id)) lastKnown = i
    }
    // 一条都对不上：数据源换了一批（换账号、本地库重建），拼起来只会得到两批无关内容
    if (lastKnown === -1 && entries.value.length > 0) {
      entries.value = next
      hasMore.value = next.length >= limit && limit < maxEntries
      return hasMore.value
    }
    const tail = next.slice(lastKnown + 1).filter(e => !known.has(e.id))
    if (tail.length) entries.value = [...entries.value, ...tail]

    hasMore.value = next.length >= limit && limit < maxEntries
    return hasMore.value
  }

  /**
   * 同步完成后的入口（页面 watch syncStatuses 的 version 时调用）。
   *
   * 只更新「已同步 N 条」，一个字都不动列表——同步永远不打断用户正在读的位置。
   */
  function refreshFromSync(): void {
    const delta = syncedDocs() - seenDocs
    if (delta > 0) newCount.value = delta
  }

  /** 用户点「查看」：重新从本地库加载最新数据，并回到列表顶部 */
  async function applyNew(): Promise<void> {
    await load()
    scrollListToTop(listAnchorRef.value)
  }

  return {
    entries,
    newCount,
    hasMore,
    listAnchorRef,
    load,
    grow,
    refreshFromSync,
    applyNew
  }
}

/** 从锚点向上找第一个可滚动祖先（页面滚动容器可能是 window，也可能是面板内的滚动区） */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/** 应用待更新后回到列表顶部（点了「查看」就是要看它） */
function scrollListToTop(anchor: HTMLElement | null) {
  if (typeof window === 'undefined') return
  try {
    const scroller = anchor ? findScrollParent(anchor) : null
    if (scroller) {
      scroller.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  } catch {
    // 滚动失败不影响数据上屏
  }
}
