import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useSyncedEntryList } from '../../composables/useSyncedEntryList'
import type { RssEntry } from '../../types/rss'

// 复刻 Nuxt auto-import：composable 内部直接引用全局 ref
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref

function makeEntry(id: string): RssEntry {
  return {
    id,
    feedId: 'feed-1',
    title: `标题 ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0
  }
}

const ids = (list: { entries: { value: RssEntry[] } }) => list.entries.value.map(e => e.id)

/** 模拟列表滚动位置：>0 表示用户已经往下读（不在顶部） */
function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true })
}

describe('useSyncedEntryList', () => {
  beforeEach(() => {
    // applyPending 会滚回列表顶部；测试不关心滚动，替换掉避免依赖 happy-dom 实现
    window.scrollTo = (() => {}) as typeof window.scrollTo
    setScrollY(0)
  })

  it('首屏加载直接上屏，不产生提示', async () => {
    const list = useSyncedEntryList({ query: async () => [makeEntry('c'), makeEntry('b')] })

    await list.load()

    expect(ids(list)).toEqual(['c', 'b'])
    expect(list.pendingCount.value).toBe(0)
    // 返回条数未达窗口上限 → 没有更多
    expect(list.hasMore.value).toBe(false)
  })

  it('停在列表顶部时头部新增直接上屏（首屏逐源同步不该被提示条拦住）', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync()

    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('已往下读时，同步拿到头部新条目：不上屏、只提示，用户点击后才上屏', async () => {
    setScrollY(600)
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync()

    // 正在读的列表没被推动
    expect(ids(list)).toEqual(['b', 'a'])
    expect(list.pendingCount.value).toBe(1)

    list.applyPending()
    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('新增排在当前列表之后：静默上屏（阅读位置不变）', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('b'), makeEntry('a'), makeEntry('z')]
    await list.refreshFromSync()

    expect(ids(list)).toEqual(['b', 'a', 'z'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('用户主动点同步按钮：即便已往下读，新条目也直接上屏', async () => {
    setScrollY(600)
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync(true)

    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('加载更多时头部未确认的新条目不会顺带上屏，只接上尾部扩展', async () => {
    setScrollY(600)
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows, pageSize: 2 })
    await list.load()

    // 窗口扩到 4：头部来了新条目 c，尾部多了更旧的 z
    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a'), makeEntry('z')]
    await list.grow()

    expect(ids(list)).toEqual(['b', 'a', 'z'])
    expect(list.pendingCount.value).toBe(1) // 只算还没上屏的 c
    expect(list.hasMore.value).toBe(true)

    list.applyPending()
    expect(ids(list)).toEqual(['c', 'b', 'a', 'z'])
  })

  it('尾部扩展已上屏的条目不重复计入提示数', async () => {
    setScrollY(600)
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows, pageSize: 2 })
    await list.load()

    rows = [makeEntry('c'), makeEntry('d'), makeEntry('b'), makeEntry('a')]
    await list.grow()

    expect(ids(list)).toEqual(['b', 'a'])
    expect(list.pendingCount.value).toBe(2) // c、d 都还没上屏

    list.applyPending()
    expect(ids(list)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('后台同步查询结果与当前列表一致时不替换数组（避免无谓的整列重排）', async () => {
    const list = useSyncedEntryList({ query: async () => [makeEntry('b'), makeEntry('a')] })
    await list.load()
    const before = list.entries.value

    await list.refreshFromSync()

    expect(list.entries.value).toBe(before)
  })

  it('用户主动同步即便内容一致也会重新读一遍', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows.map(e => ({ ...e })) })
    await list.load()
    const before = list.entries.value

    rows = [makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync(true)

    expect(list.entries.value).not.toBe(before)
    expect(ids(list)).toEqual(['b', 'a'])
  })

  it('密集同步完成只重查一次（防抖）', async () => {
    vi.useFakeTimers()
    try {
      const query = vi.fn(async () => [makeEntry('a')])
      const list = useSyncedEntryList({ query, debounceMs: 200 })
      await list.load()
      expect(query).toHaveBeenCalledTimes(1)

      void list.refreshFromSync()
      void list.refreshFromSync()
      void list.refreshFromSync()
      expect(query).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(200)
      expect(query).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('并发重查时旧查询结果不覆盖新结果', async () => {
    const pendingResolvers: Array<(rows: RssEntry[]) => void> = []
    const slow = new Promise<RssEntry[]>((resolve) => {
      pendingResolvers.push(resolve)
    })
    const calls = [slow, Promise.resolve([makeEntry('b'), makeEntry('a')])]
    let call = 0
    const list = useSyncedEntryList({ query: () => calls[call++]! })

    const first = list.load() // 慢查询
    const second = list.load() // 后发的快查询先返回
    await second
    expect(ids(list)).toEqual(['b', 'a'])

    pendingResolvers[0]!([makeEntry('x')]) // 慢查询姗姗来迟，应被作废
    await first
    expect(ids(list)).toEqual(['b', 'a'])
  })
})
