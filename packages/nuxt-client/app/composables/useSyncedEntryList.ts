import type { Ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { diffEntryHeads, withStableHead } from '~/utils/entrySync'
import { readReadingMark, writeReadingMark, type ReadingMark } from '~/utils/readingMark'
import { currentAccountId } from '~/utils/sessionState'

export interface UseSyncedEntryListOptions {
  /** 按窗口大小查询本地集中库（时间线 / 单源 / 分组 / bot 产出各不同） */
  query: (limit: number) => Promise<RssEntry[]>
  /** 每页条数（无限滚动步长） */
  pageSize?: number
  /** 查询窗口上限，达到后不再加载 */
  maxEntries?: number
  /** 同步完成后的重查防抖：订阅源多时逐源完成会密集触发，合并成一次重查 */
  debounceMs?: number
  /**
   * 列表标识（如 `timeline` / `feed:${feedId}`），同一列表每次挂载传同一个值。
   *
   * 传了才跨页面、跨刷新记住「读到哪」：切走再点回来（内存快照）或刷新浏览器（落盘基准）时，
   * 先把上次的列表摆回来，期间同步到的新条目先进提示条。不传则不保留（一次性列表与单测用）。
   */
  stateKey?: string
}

/** 同一会话内的列表快照：SPA 导航回来时立刻显示上次的列表，不闪 loading */
interface ListSnapshot {
  /** 快照归属账号：换账号后条目来自上一个账号的本地库，不能再摆给用户 */
  accountId: string | null
  entries: RssEntry[]
  /** 恢复时连查询窗口一起还原，避免回来列表被截短 */
  displayLimit: number
  hasMore: boolean
}

/**
 * 条目列表的数据源与刷新策略：把「后台同步拿到的新条目」和「用户正在读的列表」解耦。
 *
 * 上屏规则只有两条：
 *   1. 头部有新增 → 先累计成「N 条新内容」提示条，用户点了才上屏，不推走正在读的内容；
 *      头部没有新增（内容更新 / 尾部扩展 / 条目删除）→ 静默上屏，阅读位置不受影响。
 *      首屏填充时列表还是空的，没有「头部新增」可言，自然不被提示条拦着。
 *   2. 用户主动点同步按钮 → 他此刻就是要看最新内容，直接上屏。
 *
 * 「读到哪」由 options.stateKey 提供，两层存储但只有一处写入（persistState）：
 *   - 内存快照（Nuxt 应用级 state）：SPA 导航回来时立刻把上次的列表摆回去，不闪 loading；
 *   - 落盘基准（sessionStorage，只存上次列表第一条的 id）：刷新浏览器后从本地库重查，
 *     按基准把窗口切两半——新内容进提示条，基准及更旧的摆回列表。
 * 接上基准的这次挂载里，头部新增同样进提示条：页面刚挂载时滚动位置必然是顶部，
 * 光看「在不在顶部」判断不出用户读没读过，所以干脆不看滚动位置。
 *
 * 无限滚动（grow）走同一套：窗口变大时尾部条目接上，头部新增仍留给提示条。
 */
export function useSyncedEntryList(options: UseSyncedEntryListOptions) {
  const pageSize = options.pageSize ?? 50
  const maxEntries = options.maxEntries ?? 10000
  const debounceMs = options.debounceMs ?? 0
  const stateKey = options.stateKey

  const accountId = currentAccountId()
  // 内存快照：SPA 页面切换时保留，刷新浏览器即失效
  const snapshot = stateKey
    ? useState<ListSnapshot | null>(`synced-entry-list:${stateKey}`, () => null)
    : null
  const saved = restoreSnapshot(snapshot, accountId)
  // 落盘基准：刷新浏览器后接手内存快照的职责
  const mark = stateKey ? readReadingMark(stateKey, accountId) : null
  /** 刷新后没有内存快照、但有落盘基准：首屏要先按基准把上次的列表摆回来 */
  let needMarkRestore = saved === null && mark !== null

  const entries = ref<RssEntry[]>(saved?.entries ?? [])
  /** 查询窗口：无限滚动逐步增大，同步刷新时保留当前深度（用户翻到第几页不丢） */
  const displayLimit = ref(saved?.displayLimit ?? mark?.displayLimit ?? pageSize)
  const hasMore = ref(saved?.hasMore ?? true)
  /** 待用户确认的新窗口（头部有新增时暂存，不上屏） */
  let pending: RssEntry[] | null = null
  const pendingCount = ref(0)
  /** 列表顶部锚点：应用待更新时据此找到滚动容器并回顶 */
  const listAnchorRef = ref<HTMLElement | null>(null)

  /** 在途查询的代次：并发重查时只认最后一次，避免旧窗口结果覆盖新结果 */
  let generation = 0
  /** 待执行的防抖定时器 */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 是否正在按落盘基准恢复列表：这期间 entries 还是空的，同步触发的重查要先挡下 */
  let restoring = false
  /** 恢复期间被挡下的重查，恢复完成后再补一次 */
  let refreshSkipped = false

  function clearPending() {
    pending = null
    pendingCount.value = 0
  }

  /** 列表内容有变化就落一次状态：内存快照供 SPA 导航恢复，落盘基准供刷新后恢复 */
  function persistState() {
    if (snapshot) {
      snapshot.value = {
        accountId,
        entries: entries.value,
        displayLimit: displayLimit.value,
        hasMore: hasMore.value
      }
    }
    if (!stateKey) return
    const head = entries.value[0]
    writeReadingMark(
      stateKey,
      head ? { accountId, headId: head.id, displayLimit: displayLimit.value } : null
    )
  }

  /** 查询窗口；期间又发起了新查询（含用户点击应用）时返回 null 表示本次结果作废 */
  async function queryWindow(limit = displayLimit.value): Promise<RssEntry[] | null> {
    const gen = ++generation
    const list = await options.query(limit)
    return gen === generation ? list : null
  }

  /**
   * 上屏一次窗口查询结果。
   * allowHeadInsertion=true 表示这次刷新出自用户主动同步，头部新增直接上屏。
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
    // 新窗口与当前列表一条都对不上：数据源换了一批（本地库重建、快照残留），
    // 别把两批内容拼在一起，直接按最新内容上屏
    const overlap = nextIds.length - diff.addedCount
    if (!allowHeadInsertion && currentIds.length > 0 && nextIds.length > 0 && overlap === 0) {
      entries.value = next
      clearPending()
      persistState()
      return
    }
    // 头部有新增：先收进提示条。insertedAtHead 成立即蕴含当前列表非空，首屏填充不会走到这里
    if (!allowHeadInsertion && diff.insertedAtHead) {
      const visible = withStableHead(entries.value, next)
      const visibleIds = new Set(visible.map(e => e.id))
      entries.value = visible
      pending = next
      // 只把「还没上屏」的新条目算进提示数：尾部扩展/补齐已经接上了，不重复计数
      pendingCount.value = next.reduce((n, e) => (visibleIds.has(e.id) ? n : n + 1), 0)
      persistState()
      return
    }
    entries.value = next
    clearPending()
    persistState()
  }

  /** 查一次当前窗口并按规则上屏 */
  async function applyQuery(allowHeadInsertion: boolean) {
    // 基准恢复期间先不查：此刻 entries 还是空的，上屏会把新条目铺满首屏，
    // 挡住正要摆回来的上次列表。恢复结束后会补查一次。
    if (restoring && !allowHeadInsertion) {
      refreshSkipped = true
      return
    }
    const next = await queryWindow()
    if (!next) return
    applyWindow(next, allowHeadInsertion)
  }

  /**
   * 刷新后回到列表：用「上次列表的第一条」把最新窗口切成两半——
   * 新于它的先收进提示条，它及更旧的摆回列表。
   */
  async function restoreFromMark(base: ReadingMark): Promise<void> {
    const first = await queryWindow()
    if (!first) return
    const idx = first.findIndex(e => e.id === base.headId)
    if (idx <= 0) {
      // idx<0：基准已不在本地库（条目被清理），恢复不了；idx==0：期间没有新条目，窗口就是上次的列表。
      // 两种都按常规规则上屏即可。
      if (idx < 0 && stateKey) writeReadingMark(stateKey, null)
      applyWindow(first, false)
      return
    }
    // 放大窗口重查一次，让「基准及更旧」的内容补满一整页，列表不会因为切掉新条目而变短
    const wider = await queryWindow(Math.min(displayLimit.value + idx, maxEntries))
    if (!wider) return
    const at = wider.findIndex(e => e.id === base.headId)
    if (at <= 0) {
      applyWindow(first, false)
      return
    }
    // 先把上次的列表摆回去，再让 applyWindow 按常规规则把新条目收进提示条
    // （它会用 withStableHead 剔掉排在前面的新条目，并补回被窗口挤出的旧条目）
    entries.value = wider.slice(at)
    applyWindow(wider.slice(0, displayLimit.value), false)
  }

  /** 重查当前窗口并上屏（首屏调用）；刷新后先按落盘基准把上次的列表摆回来 */
  async function load(): Promise<void> {
    if (!needMarkRestore || !mark) {
      await applyQuery(false)
      return
    }
    // 恢复只做一次：后续的 grow / 同步刷新都走常规路径
    needMarkRestore = false
    restoring = true
    try {
      await restoreFromMark(mark)
    } finally {
      restoring = false
    }
    if (refreshSkipped) {
      refreshSkipped = false
      await applyQuery(false)
    }
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
   * userInitiated=true（用户点了同步按钮）时立即上屏；否则走防抖，新条目进提示条。
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
    persistState()
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

/**
 * 读出可用快照：账号对得上且确实有内容。
 * 对不上（换了账号、已登录状态变化）就丢掉，避免把上一个账号的条目摆给用户。
 */
function restoreSnapshot(
  snapshot: Ref<ListSnapshot | null> | null,
  accountId: string | null
): ListSnapshot | null {
  if (!snapshot) return null
  const saved = snapshot.value
  if (!saved || saved.entries.length === 0 || saved.accountId !== accountId) {
    if (snapshot.value) snapshot.value = null
    return null
  }
  return saved
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
