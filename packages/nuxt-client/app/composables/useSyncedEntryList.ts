import type { RssEntry } from '~/types/rss'
import { diffEntryHeads, withStableHead } from '~/utils/entrySync'

export interface UseSyncedEntryListOptions {
  /** 按窗口大小查询本地集中库（时间线 / 单源 / 分组 / bot 产出各不同） */
  query: (limit: number) => Promise<RssEntry[]>
  /** 每页条数（无限滚动步长） */
  pageSize?: number
  /** 查询窗口上限，达到后不再加载 */
  maxEntries?: number
  /** 同步完成后的重查防抖：订阅源多时逐源完成会密集触发，合并成一次重查 */
  debounceMs?: number
}

/**
 * 条目列表的数据源与刷新策略：把「后台同步拿到的新条目」和「用户正在读的列表」解耦。
 *
 * 背景：列表按发布时间倒序，同步完成后若无条件 `entries = 查询结果`，新条目会插到头部，
 * 把用户正在读的内容推走。这里改为——
 *   - 头部没有新增（内容更新 / 尾部新增 / 条目删除）：静默上屏，阅读位置不变；
 *   - 头部有新增：只累计 `pendingCount` 显示「N 条新内容」提示，等用户点击 `applyPending` 才上屏；
 *   - 用户主动点同步按钮（userInitiated）：直接上屏，用户此刻就是要看最新内容。
 *
 * 无限滚动（grow）也走同一套保护：窗口变大时尾部条目接上，头部新增仍留给提示条。
 */
export function useSyncedEntryList(options: UseSyncedEntryListOptions) {
  const pageSize = options.pageSize ?? 50
  const maxEntries = options.maxEntries ?? 10000
  const debounceMs = options.debounceMs ?? 0

  const entries = ref<RssEntry[]>([])
  /** 查询窗口：无限滚动逐步增大，同步刷新时保留当前深度（用户翻到第几页不丢） */
  const displayLimit = ref(pageSize)
  const hasMore = ref(true)
  /** 待用户确认的新窗口（头部有新增时暂存，不上屏） */
  let pending: RssEntry[] | null = null
  const pendingCount = ref(0)
  /** 列表顶部锚点：应用待更新时据此找到滚动容器并回顶 */
  const listAnchorRef = ref<HTMLElement | null>(null)

  /** 在途查询的代次：并发重查时只认最后一次，避免旧窗口结果覆盖新结果 */
  let generation = 0
  /** 待执行的防抖定时器 */
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearPending() {
    pending = null
    pendingCount.value = 0
  }

  /** 查询当前窗口；期间又发起了新查询（含用户点击应用）时返回 null 表示本次结果作废 */
  async function queryWindow(): Promise<RssEntry[] | null> {
    const gen = ++generation
    const list = await options.query(displayLimit.value)
    return gen === generation ? list : null
  }

  /**
   * 上屏一次窗口查询结果。
   * allowHeadInsertion=true 表示这次刷新出自用户主动行为，头部新增直接上屏；
   * 否则仅当用户已经往下读（列表不在顶部）时转提示条，停在顶部时照常上屏——
   * 首屏同步是逐个源完成的，用户在顶部等待时不该被提示条拦着。
   */
  function applyWindow(next: RssEntry[], allowHeadInsertion: boolean) {
    const currentIds = entries.value.map(e => e.id)
    const nextIds = next.map(e => e.id)
    const diff = diffEntryHeads(currentIds, nextIds)
    hasMore.value = next.length >= displayLimit.value && displayLimit.value < maxEntries
    // 与当前列表逐条一致：直接跳过。后台同步每完成一个源就会重查一次，绝大多数结果没变；
    // 把整个数组换成新对象会让所有卡片重新 patch，在多列布局（UPageColumns）下引起滚动漂移。
    // 用户主动刷新（allowHeadInsertion）不跳过，保证内容/元信息一定重新读一遍。
    const unchanged = currentIds.length === nextIds.length
      && currentIds.every((id, i) => id === nextIds[i])
    if (!allowHeadInsertion && unchanged) return
    if (!allowHeadInsertion && diff.insertedAtHead && !isAtListTop(listAnchorRef.value)) {
      const visible = withStableHead(entries.value, next)
      const visibleIds = new Set(visible.map(e => e.id))
      entries.value = visible
      pending = next
      // 只把「还没上屏」的新条目算进提示数：尾部扩展/补齐已经接上了，不重复计数
      pendingCount.value = next.reduce((n, e) => (visibleIds.has(e.id) ? n : n + 1), 0)
      return
    }
    entries.value = next
    clearPending()
  }

  /** 查一次当前窗口并按规则上屏 */
  async function applyQuery(allowHeadInsertion: boolean) {
    const next = await queryWindow()
    if (!next) return
    applyWindow(next, allowHeadInsertion)
  }

  /** 重查当前窗口并上屏（首屏调用） */
  async function load(): Promise<void> {
    await applyQuery(false)
  }

  /** 无限滚动：窗口 +1 页后重查；返回是否还有更多 */
  async function grow(): Promise<boolean> {
    if (!hasMore.value) return false
    displayLimit.value += pageSize
    await load()
    return hasMore.value
  }

  /**
   * 同步完成后的刷新入口（页面 watch syncStatuses 的 version 时调用）。
   * userInitiated=true（用户点了同步按钮）时立即上屏；否则走防抖并保护阅读位置。
   */
  async function refreshFromSync(userInitiated = false): Promise<void> {
    if (userInitiated) {
      // 用户主动同步：取消待执行的防抖，立即给结果
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await applyQuery(true)
      return
    }
    if (debounceMs <= 0) {
      await applyQuery(false)
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void applyQuery(false)
    }, debounceMs)
  }

  /** 用户点击「N 条新内容」：上屏并回到列表顶部，让新条目落在视野里 */
  function applyPending() {
    if (!pending) return
    // 作废在途查询，避免旧窗口结果盖掉刚应用的新内容
    generation++
    entries.value = pending
    hasMore.value = pending.length >= displayLimit.value && displayLimit.value < maxEntries
    clearPending()
    scrollListToTop(listAnchorRef.value)
  }

  return {
    entries,
    pendingCount,
    hasMore,
    listAnchorRef,
    load,
    grow,
    refreshFromSync,
    applyPending
  }
}

/** 顶部判定容差：滚动量在此之内视为「还在列表顶部」 */
const AT_TOP_GAP = 32

/**
 * 列表是否停在顶部。用户还没往下读时，新条目接在头部就是他期待的行为；
 * 已经翻到下面阅读时才需要提示条保护。
 */
function isAtListTop(anchor: HTMLElement | null): boolean {
  if (typeof window === 'undefined') return true
  try {
    const scroller = findScrollParent(anchor)
    if (scroller) return scroller.scrollTop <= AT_TOP_GAP
    return (window.scrollY || 0) <= AT_TOP_GAP
  } catch {
    // 拿不到滚动位置时按「在顶部」处理：首屏填充不该被提示条拦住
    return true
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

/** 应用待更新后回到列表顶部（点了「新内容」就是要看它） */
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
