import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { useUnreadFilter } from '../../composables/useUnreadFilter'
import type { ScanCursor, ScanPage } from '../../composables/usePouchDb'
import type { RssEntry } from '../../types/rss'

/**
 * 「只看未读」：扫描与上屏拆开。
 *
 * 盯六件事：
 *   1. 扫描按游标深挖、**只收未读**，并且不经过 enrich（只给要上屏的几十条付这个成本）；
 *   2. 一页扫出的未读多于一屏时，剩下的留在缓冲区，下一轮先消化，不能丢；
 *   3. 单轮有 maxScan 上限：扫满就停，不能谎报「没有未读」，下一轮接着扫；
 *   4. 扫描上界是当前快照最新一条（同步进来的新条目不提前露面），快照换了要重扫；
 *   5. 筛选关掉/打开时两种列表来源的切换；
 *   6. **上屏的这批是快照**：读过的条目留在原位，只有 refreshUnread 才移出并重新扫。
 *
 * 用假 scan 复刻 usePouchDb 的分页语义：`after` 表示「这一行已消费」，从它的下一行开始。
 */

const nuxtGlobals = globalThis as unknown as Record<string, unknown>
const stateCache = new Map<string, Ref<unknown>>()
nuxtGlobals.useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()) as Ref<unknown>)
  return stateCache.get(key) as Ref<T>
})

function makeEntry(i: number): RssEntry {
  return {
    id: `e${i}`,
    feedId: 'feed-1',
    title: `标题 ${i}`,
    url: `https://example.com/${i}`,
    // i 越小越新：world 数组本身就是时间倒序
    publishedAt: new Date(Date.UTC(2026, 0, 1) - i * 3600_000).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, 1) - i * 3600_000).toISOString(),
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** 一次 set + 让 watch/异步探针跑完 */
async function settle() {
  await nextTick()
  await flush()
  await nextTick()
  await flush()
}

/**
 * 假世界：按时间倒序的条目 + 已读集合。scan 的分页语义与 usePouchDb 的 scan*Page 一致：
 * `cursor` 是「上一页最后一行（已消费）」；首轮 cursor 为 null，从世界（本地库）最新一条开始，
 * 不受列表快照约束。
 */
function makeWorld(world: RssEntry[], readIds: Set<string>) {
  return async (
    cursor: ScanCursor | null,
    limit: number
  ): Promise<ScanPage<ScanCursor>> => {
    let startIdx = 0
    if (cursor) {
      const idx = world.findIndex(e => e.id === cursor.id)
      startIdx = idx === -1 ? 0 : idx + 1
    }
    const rows = world.slice(startIdx, startIdx + limit)
      .map(entry => ({ ...entry, read: readIds.has(entry.id) }))
    const last = rows[rows.length - 1]
    return {
      rows,
      cursor: last ? { ms: Date.parse(last.publishedAt), id: last.id } : { ms: 0, id: '' },
      exhausted: rows.length < limit
    }
  }
}

interface HarnessOptions {
  entries: RssEntry[]
  world?: RssEntry[]
  readIds?: Set<string>
  scanBatch?: number
  maxScan?: number
  target?: number
  anchor?: () => HTMLElement | null
}

function setup(options: HarnessOptions) {
  const entries = ref<RssEntry[]>(options.entries)
  const world = options.world ?? options.entries
  const readIds = options.readIds ?? new Set<string>()
  const scan = vi.fn(makeWorld(world, readIds))
  const enrich = vi.fn(async (list: RssEntry[]) => list.map(e => ({ ...e, title: `${e.title}（已 enrich）` })))
  const grow = vi.fn(async () => true)

  const filter = useUnreadFilter<ScanCursor>({
    entries,
    hasMore: () => true,
    grow,
    scan,
    enrich,
    scanBatch: options.scanBatch,
    maxScan: options.maxScan,
    target: options.target,
    anchor: options.anchor
  })

  return { entries, world, readIds, scan, enrich, grow, filter }
}

const idsOf = (list: RssEntry[]) => list.map(e => e.id)

beforeEach(() => {
  stateCache.clear()
})

describe('useUnreadFilter：筛选关掉时走原始列表', () => {
  it('原样返回原始快照，loadMore 走原始 grow，不碰扫描', async () => {
    const { filter, grow, scan, entries } = setup({ entries: [makeEntry(0), makeEntry(1)] })

    expect(filter.unreadOnly.value).toBe(false)
    expect(filter.visibleEntries.value).toBe(entries.value)
    expect(filter.visibleHasMore()).toBe(true)

    await filter.loadMoreVisible()

    expect(grow).toHaveBeenCalledTimes(1)
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('useUnreadFilter：扫描未读', () => {
  it('打开后沿时间序扫描，只收未读，且只对要上屏的那批做 enrich', async () => {
    const world = Array.from({ length: 10 }, (_, i) => makeEntry(i))
    const { filter, scan, enrich } = setup({
      entries: world,
      world,
      readIds: new Set(['e0', 'e1', 'e2', 'e4'])
    })

    filter.toggleUnreadOnly()
    await settle()

    expect(filter.unreadOnly.value).toBe(true)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e3', 'e5', 'e6', 'e7', 'e8', 'e9'])
    // 扫了 10 行，但只 enrich 上屏的 6 条 —— 这就是「扫描不 enrich」的收益
    expect(filter.scannedCount.value).toBe(10)
    expect(enrich).toHaveBeenCalledTimes(1)
    expect(enrich.mock.calls[0]![0]).toHaveLength(6)
    expect(filter.visibleEntries.value[0]!.title).toContain('已 enrich')
    // 扫到底：页尾提示换成「已加载全部」
    expect(filter.visibleHasMore()).toBe(false)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('不受列表快照约束：同步刚到、还没点「查看」的新条目，切进来就在（完整刷新）', async () => {
    const world = [makeEntry(0), makeEntry(1), makeEntry(2)]
    // 快照里只有 e1、e2（e0 是同步刚到、用户还没点「查看」的）；e0、e2 都未读
    const { filter, scan } = setup({ entries: world.slice(1), world, readIds: new Set(['e1']) })

    filter.toggleUnreadOnly()
    await settle()

    // e0 虽不在快照里，但「切进未读 = 完整刷新」，最新的未读一样要上屏
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e2'])
    // 首轮不带游标：交给 scan 层从本地库最新一条开始
    expect(scan.mock.calls[0]![0]).toBeNull()
  })

  it('一页扫出的未读多于一屏：剩下的留在缓冲区，下一轮接着上屏且不重复', async () => {
    const world = Array.from({ length: 10 }, (_, i) => makeEntry(i))
    const { filter, scan } = setup({ entries: world, world, scanBatch: 4, target: 3 })

    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])

    await filter.loadMoreVisible()
    await settle()

    // 第一页剩的 e3 先消化，再往下扫 e4..e7，凑够 3 条新的
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5'])
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('单轮扫到 maxScan 就停：不谎报「没有未读」，下一轮从游标继续（不重扫）', async () => {
    const world = Array.from({ length: 10 }, (_, i) => makeEntry(i))
    // 只有最后一条 e9 未读，每页 4 行、单轮最多 4 行 → 要三轮才能挖到
    const { filter, scan } = setup({ entries: world, world, readIds: new Set(world.slice(0, 9).map(e => e.id)), scanBatch: 4, maxScan: 4, target: 2 })

    filter.toggleUnreadOnly()
    await settle()

    expect(idsOf(filter.visibleEntries.value)).toEqual([])
    expect(filter.probing.value).toBe(false)
    // 还有没扫完的：不能断言「没有未读」
    expect(filter.visibleHasMore()).toBe(true)
    expect(filter.scannedCount.value).toBe(4)

    await filter.loadMoreVisible()
    await settle()
    expect(filter.scannedCount.value).toBe(8)
    expect(idsOf(filter.visibleEntries.value)).toEqual([])

    await filter.loadMoreVisible()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e9'])
    expect(filter.visibleHasMore()).toBe(false)
    // 三轮各扫 4/4/2 行，游标一路往前，没有从头重扫
    expect(scan).toHaveBeenCalledTimes(3)
    expect(scan.mock.calls.map(call => call[0]?.id)).toEqual([undefined, 'e3', 'e7'])
  })

  it('未读模式下 loadMore 永远返回 true（不把 useInfiniteList 的闩闩死，关掉筛选后原始列表还能翻）', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter } = setup({ entries: world, world })

    filter.toggleUnreadOnly()
    await settle()
    expect(filter.visibleHasMore()).toBe(false) // 已经扫到底

    expect(await filter.loadMoreVisible()).toBe(true)

    filter.toggleUnreadOnly()
    expect(await filter.loadMoreVisible()).toBe(true) // 关掉筛选后仍可继续翻原始列表
  })

  it('切走再切回会重扫：别处标读过的条目不会留在未读列表里', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const readIds = new Set<string>()
    const { filter, scan } = setup({ entries: world, world, readIds })

    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])

    // 在别处（比如原始列表里打开条目）把它读掉了
    readIds.add('e0')
    filter.toggleUnreadOnly()
    filter.toggleUnreadOnly()
    await settle()

    expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2'])
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('列表快照换了（点了「查看」）不需要重扫：未读扫描本来就不看快照', async () => {
    const world = [makeEntry(0), makeEntry(1)]
    const entries = ref<RssEntry[]>([world[1]!])
    const scan = vi.fn(makeWorld(world, new Set()))
    const filter = useUnreadFilter<ScanCursor>({
      entries,
      hasMore: () => true,
      grow: async () => true,
      scan,
      enrich: async list => list
    })

    filter.toggleUnreadOnly()
    await settle()
    // 首轮就扫到世界里的全部未读（含不在快照里的 e0）
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1'])

    // 用户点了「查看」：列表快照前移。未读列表已经是完整的一批，不必再扫一遍
    entries.value = [world[0]!, world[1]!]
    await settle()

    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1'])
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('打开即已读的那条留在原位（读过的条目不当场消失）', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter } = setup({ entries: world, world })

    filter.toggleUnreadOnly()
    await settle()

    // 打开详情会就地标已读（见 useEntryDetail）：列表一个字不动，只是这条淡显
    filter.visibleEntries.value[0]!.read = true
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])
    // 移出数量如实记下来，刷新入口据此报数
    expect(filter.staleCount.value).toBe(1)
  })

  it('refreshUnread 才移出已读的：从库头重扫一批最新的未读，并回到顶部', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const readIds = new Set<string>()
    // 真 DOM：滚动容器要靠 getComputedStyle + scrollHeight 判出来（见 utils/scrollContainer），
    // 桩对象测不到；happy-dom 不做真实布局，尺寸只能手写。
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    document.body.appendChild(scroller)
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo

    const { filter, scan } = setup({ entries: world, world, readIds, anchor: () => scroller })

    try {
      filter.toggleUnreadOnly()
      await settle()
      expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])

      // 读完 e0：留在原位
      readIds.add('e0')
      filter.visibleEntries.value[0]!.read = true
      await settle()
      expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])

      await filter.refreshUnread()
      await settle()

      expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2'])
      expect(filter.staleCount.value).toBe(0)
      // 刷新是一次完整重扫：游标从 null 重新开始
      expect(scan.mock.calls.at(-1)![0]).toBeNull()
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    } finally {
      scroller.remove()
    }
  })

  it('刷新会带回同步新到的未读（重扫不看原来的游标与缓冲区）', async () => {
    const world = [makeEntry(1), makeEntry(2)]
    const readIds = new Set<string>()
    const scan = vi.fn(makeWorld(world, readIds))
    const entries = ref<RssEntry[]>([...world])
    const filter = useUnreadFilter<ScanCursor>({
      entries,
      hasMore: () => true,
      grow: async () => true,
      scan,
      enrich: async list => list
    })

    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2'])

    // 同步把更新的 e0 写进本地库，并把 e1 读掉了
    world.unshift(makeEntry(0))
    readIds.add('e1')

    await filter.refreshUnread()
    await settle()

    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e2'])
  })

  it('扫描在途时点刷新：刷新接管，不被「正在扫描」静默挡掉', async () => {
    const world = Array.from({ length: 6 }, (_, i) => makeEntry(i))
    const readIds = new Set<string>()
    // 手动控制何时返回第一页：制造「刷新时还在扫」的现场
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = makeWorld(world, readIds)
    const scan = vi.fn(async (cursor: ScanCursor | null, limit: number) => {
      if (!cursor) await gate
      return inner(cursor, limit)
    })
    const filter = useUnreadFilter<ScanCursor>({
      entries: ref<RssEntry[]>([...world]),
      hasMore: () => true,
      grow: async () => true,
      scan,
      enrich: async list => list
    })

    filter.toggleUnreadOnly()
    expect(filter.probing.value).toBe(true)

    readIds.add('e0')
    const refreshed = filter.refreshUnread()
    expect(filter.probing.value).toBe(true) // 接管之后新的那一轮已经在跑
    release()

    await refreshed
    await settle()

    expect(filter.probing.value).toBe(false)
    // 首轮的结果被作废：上屏的是刷新那一轮扫到的（e0 已读，不该出现）
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  })

  it('未读模式下点刷新之前，切回「显示全部」不受影响', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter } = setup({ entries: world, world })

    // 没开未读：刷新什么都不做（页面上这一项也只在未读模式出现）
    expect(await filter.refreshUnread()).toBe(false)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])
  })

  it('扫描中 probing 为 true（页面据此显示「正在扫描未读」而不是「没有未读」）', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter } = setup({ entries: world, world })

    filter.toggleUnreadOnly()
    expect(filter.probing.value).toBe(true)

    await settle()
    expect(filter.probing.value).toBe(false)
  })
})

describe('useUnreadFilter：页面往返', () => {
  it('重新挂载时开关仍是未读模式：页面调用 resumeUnreadScan 补扫，不会误报「没有未读条目」', async () => {
    // 上一次会话把开关留在了未读模式（useState 是会话级的，页面卸载不会关掉它）
    stateCache.set('entries-unread-only', ref(true))

    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter, scan } = setup({ entries: world, world, readIds: new Set(['e0']) })

    // 新实例：扫描结果还是空的，页面挂载后补扫这一下
    expect(filter.visibleEntries.value).toEqual([])
    filter.resumeUnreadScan()
    await settle()

    expect(filter.unreadOnly.value).toBe(true)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2'])
    expect(scan).toHaveBeenCalledTimes(1)
    expect(filter.probing.value).toBe(false)
  })

  it('重新挂载时开关是「显示全部」：resumeUnreadScan 不扫描，直接用原始列表', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter, scan } = setup({ entries: world, world })

    filter.resumeUnreadScan()
    await settle()

    expect(filter.unreadOnly.value).toBe(false)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2'])
    expect(scan).not.toHaveBeenCalled()
  })
})
