import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { useUnreadFilter } from '../../composables/useUnreadFilter'
import type { ScanCursor, ScanPage } from '../../composables/usePouchDb'
import type { RssEntry } from '../../types/rss'

/**
 * 「只看未读」：扫描与上屏拆开。
 *
 * 盯五件事：
 *   1. 扫描按游标深挖、**只收未读**，并且不经过 enrich（只给要上屏的几十条付这个成本）；
 *   2. 一页扫出的未读多于一屏时，剩下的留在缓冲区，下一轮先消化，不能丢；
 *   3. 单轮有 maxScan 上限：扫满就停，不能谎报「没有未读」，下一轮接着扫；
 *   4. 扫描上界是当前快照最新一条（同步进来的新条目不提前露面），快照换了要重扫；
 *   5. 筛选关掉/打开、读取中弹窗的那条怎么办。
 *
 * 用假 scan 复刻 usePouchDb 的分页语义：`after` 表示「这一行已消费」，从它的下一行开始。
 */

const nuxtGlobals = globalThis as unknown as Record<string, unknown>
const stateCache = new Map<string, Ref<unknown>>()
nuxtGlobals.useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()) as Ref<unknown>)
  return stateCache.get(key) as Ref<T>
})

const H = {
  isOpen: ref(false),
  currentEntry: ref<RssEntry | null>(null)
}
nuxtGlobals.useEntryModal = () => ({
  isOpen: H.isOpen,
  currentEntry: H.currentEntry,
  entries: computed(() => []),
  openEntry: vi.fn(),
  closeEntry: vi.fn(),
  goPrev: vi.fn(),
  goNext: vi.fn(),
  canGoPrev: computed(() => false),
  canGoNext: computed(() => false),
  isLastWithNoMore: () => false
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
    target: options.target
  })

  return { entries, world, readIds, scan, enrich, grow, filter }
}

const idsOf = (list: RssEntry[]) => list.map(e => e.id)

beforeEach(() => {
  stateCache.clear()
  H.isOpen.value = false
  H.currentEntry.value = null
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

  it('读取中弹窗里的那条即使已读也留在列表里，关闭后消失', async () => {
    const world = Array.from({ length: 3 }, (_, i) => makeEntry(i))
    const { filter } = setup({ entries: world, world })

    filter.toggleUnreadOnly()
    await settle()
    const open = filter.visibleEntries.value[0]!
    H.isOpen.value = true
    H.currentEntry.value = open

    // 自动标已读：弹窗里这条还得留着，否则「上一篇/下一篇」失去基准
    open.read = true
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toContain(open.id)

    H.isOpen.value = false
    await settle()
    expect(idsOf(filter.visibleEntries.value)).not.toContain(open.id)
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
