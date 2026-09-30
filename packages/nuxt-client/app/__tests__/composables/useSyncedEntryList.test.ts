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

/** 可控的「已同步写入文档数」源，对应页面传入的 syncedDocs() */
function syncedCounter(initial = 0) {
  const count = ref(initial)
  return { count, docs: () => count.value }
}

describe('useSyncedEntryList', () => {
  beforeEach(() => {
    // applyNew 会滚回列表顶部；测试不关心滚动，替换掉避免依赖 happy-dom 实现
    window.scrollTo = (() => {}) as typeof window.scrollTo
  })

  it('首屏加载直接上屏，不产生提示', async () => {
    const list = useSyncedEntryList({ query: async () => [makeEntry('c'), makeEntry('b')] })

    await list.load()

    expect(ids(list)).toEqual(['c', 'b'])
    expect(list.newCount.value).toBe(0)
    // 返回条数未达窗口上限 → 没有更多
    expect(list.hasMore.value).toBe(false)
  })

  it('同步完成只累计条数：列表一个条目都不动，也不发查询', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const docs = syncedCounter(2)
    const query = vi.fn(async () => rows)
    const list = useSyncedEntryList({ query, syncedDocs: docs.docs })
    await list.load()
    const queriesAfterLoad = query.mock.calls.length

    // 同步拿到 3 条新内容（计数 2 → 5）
    rows = [makeEntry('e'), makeEntry('d'), makeEntry('c'), makeEntry('b'), makeEntry('a')]
    docs.count.value = 5
    list.refreshFromSync()

    expect(ids(list)).toEqual(['b', 'a']) // 正在读的内容没被推走
    expect(list.newCount.value).toBe(3) // 3 条待查看
    expect(query.mock.calls.length).toBe(queriesAfterLoad) // 同步不触发查询
  })

  it('用户点「查看」才整体换成最新内容并归零', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({ query: async () => rows, syncedDocs: docs.docs })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    docs.count.value = 1
    list.refreshFromSync()
    expect(ids(list)).toEqual(['b', 'a'])
    expect(list.newCount.value).toBe(1)

    await list.applyNew()

    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.newCount.value).toBe(0)
  })

  it('查看后基线对齐：旧的同步不再弹提示，只有新的增量计入', async () => {
    let rows = [makeEntry('a')]
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({ query: async () => rows, syncedDocs: docs.docs })
    await list.load()

    docs.count.value = 3
    list.refreshFromSync()
    expect(list.newCount.value).toBe(3)

    rows = [makeEntry('d'), makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.applyNew()
    expect(list.newCount.value).toBe(0)

    // 列表已是最新、计数没再涨：不弹提示
    list.refreshFromSync()
    expect(list.newCount.value).toBe(0)

    // 又同步进来 2 条
    docs.count.value = 5
    list.refreshFromSync()
    expect(list.newCount.value).toBe(2)
  })

  it('同步没有带来新内容时不弹提示', async () => {
    const docs = syncedCounter(7)
    const list = useSyncedEntryList({
      query: async () => [makeEntry('a')],
      syncedDocs: docs.docs
    })
    await list.load()

    list.refreshFromSync()
    list.refreshFromSync()

    expect(list.newCount.value).toBe(0)
  })

  it('不传 syncedDocs 的列表永远不显示提示条', async () => {
    const list = useSyncedEntryList({ query: async () => [makeEntry('a')] })
    await list.load()

    list.refreshFromSync()

    expect(list.newCount.value).toBe(0)
  })

  it('加载更多只接上尾部旧条目，头部新条目仍留给提示条', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({
      query: async (limit: number) => rows.slice(0, limit),
      pageSize: 2,
      syncedDocs: docs.docs
    })
    await list.load()
    expect(ids(list)).toEqual(['b', 'a'])

    // 窗口扩到 4：头部来了新条目 c，尾部多了更旧的 z，同时后台也报了 1 条
    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a'), makeEntry('z')]
    docs.count.value = 1
    list.refreshFromSync()
    await list.grow()

    expect(ids(list)).toEqual(['b', 'a', 'z']) // 头部没被推动
    expect(list.newCount.value).toBe(1) // 加载更多不会清掉提示条
    expect(list.hasMore.value).toBe(true)

    await list.applyNew()
    expect(ids(list)).toEqual(['c', 'b', 'a', 'z'])
    expect(list.newCount.value).toBe(0)
  })

  it('尾部没有更多内容时加载更多不改动列表', async () => {
    const list = useSyncedEntryList({
      query: async () => [makeEntry('b'), makeEntry('a')],
      pageSize: 3
    })
    await list.load()
    expect(list.hasMore.value).toBe(false)

    const again = await list.grow()

    expect(again).toBe(false)
    expect(ids(list)).toEqual(['b', 'a'])
  })

  it('加载更多时数据源整批换掉（一条都对不上）按新内容整体上屏', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({
      query: async (limit: number) => rows.slice(0, limit),
      pageSize: 2
    })
    await list.load()

    // 换账号 / 本地库重建：新窗口与当前列表毫无交集
    rows = [makeEntry('y'), makeEntry('x')]
    await list.grow()

    expect(ids(list)).toEqual(['y', 'x'])
  })

  it('查询异常返回空数组时不清空已有列表', async () => {
    let failing = false
    const list = useSyncedEntryList({
      // usePouchDb.queryByView 查询失败时返回空数组
      query: async () => (failing ? [] : [makeEntry('b'), makeEntry('a')])
    })
    await list.load()

    failing = true
    await list.load()

    expect(ids(list)).toEqual(['b', 'a'])
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
