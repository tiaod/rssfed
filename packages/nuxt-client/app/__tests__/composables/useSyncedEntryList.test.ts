import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useSyncedEntryList } from '../../composables/useSyncedEntryList'
import type { SyncOutcomeLike } from '../../composables/useSyncedEntryList'
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

  it('同步进行中每写一批就报数：不用等复制安静下来', async () => {
    // 真实链路里复制的 change 事件按批把条目记进分摊表，而 syncStatuses.version
    // 要等 paused 才 +1。提示条若只在收尾时取值，首屏几千条的全量同步全程都不显示条数。
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({ query: async () => [makeEntry('a')], syncedDocs: docs.docs })
    await list.load()
    expect(list.newCount.value).toBe(0)

    // 复制写了第一批 —— 此刻根本没调 refreshFromSync()
    docs.count.value = 20
    expect(list.newCount.value).toBe(20)

    // 又一批
    docs.count.value = 45
    expect(list.newCount.value).toBe(45)

    // 收尾（页面 watch version 调到这里）不改变数字
    list.refreshFromSync()
    expect(list.newCount.value).toBe(45)
  })

  it('计数源掉回基线以下（换账号 / 重建本地库）时基线跟着退', async () => {
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({ query: async () => [makeEntry('a')], syncedDocs: docs.docs })
    await list.load()

    docs.count.value = 100
    expect(list.newCount.value).toBe(100)

    // 换账号 / 重置缓存：分摊表被清空，新库从头计数
    docs.count.value = 0
    expect(list.newCount.value).toBe(0)

    // 新账号同步进 3 条：从 0 起算，而不是先把旧的 100 条差额补满
    docs.count.value = 3
    expect(list.newCount.value).toBe(3)
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

  it('同步删除的条目从列表快照中剔除，其余条目与待查看计数不受影响', async () => {
    // 源库裁剪后随复制删除的条目：本地文档已 404，列表必须把它们剔掉
    const removed = new Set<string>(['b'])
    const docs = syncedCounter(0)
    const list = useSyncedEntryList({
      query: async () => [makeEntry('c'), makeEntry('b'), makeEntry('a')],
      syncedDocs: docs.docs,
      removedIds: () => removed
    })
    await list.load()

    docs.count.value = 2
    list.refreshFromSync()

    expect(ids(list)).toEqual(['c', 'a'])
    expect(list.newCount.value).toBe(2)
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

  it('查询进行中同步进来的条目不会被基线吃掉（宁可多报一次，也不静默吞掉）', async () => {
    // 真实路径（冷启动 / 重开应用最容易撞上）：
    //   ① load() 发起本地查询，此刻同步计数还是 N；
    //   ② 查询在途，后台 live 复制把新条目写进本地库、计数涨到 N+3；
    //   ③ 查询返回。
    // 旧实现把基线记在**查询结束**时刻，于是这 3 条被算成「已看过」—— 提示条永不出现，
    // 而用户重开应用时正是最该看到「有新内容」的时刻（实测重开 30 秒停在「已同步 0 条」）。
    //
    // 查询有没有恰好把这几条也查进来是**不可知**的（本地查询读最新库，复制同时在写）。
    // 这里选的方向是「宁可在已经上屏时多报一次」：多点一下「查看」只是列表不变，
    // 而少报一次用户就永远不知道有新内容。
    const docs = syncedCounter(0)
    const rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    // 第一次查询挂住（模拟查询在途），之后恢复成即时返回（供 applyNew 重查）
    let gate: ((rows: RssEntry[]) => void) | null = null
    let first = true
    const query = () => {
      if (!first) return Promise.resolve(rows)
      first = false
      return new Promise<RssEntry[]>((resolve) => {
        gate = resolve
      })
    }
    const list = useSyncedEntryList({ query, syncedDocs: docs.docs })

    const loading = list.load()
    // 查询在途：同步写入 3 条（计数 0 → 3）
    docs.count.value = 3
    list.refreshFromSync()

    gate!(rows)
    await loading

    // 不静默吞掉：那 3 条仍然报给用户
    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.newCount.value).toBe(3)

    // 点「查看」后自愈：基线对齐到当前，提示条收起
    await list.applyNew()
    expect(list.newCount.value).toBe(0)

    // 之后再来 2 条照旧提示
    docs.count.value = 5
    list.refreshFromSync()
    expect(list.newCount.value).toBe(2)
  })

  it('查询在途、新条目没进这次结果时，提示条照旧出现', async () => {
    // 与上一条的区别：查询返回的是**旧窗口**（查询在同步写入之前就拿到了结果快照）。
    // 这时候那 3 条还没上屏，必须留给提示条 —— 不能因为「计数涨了但列表没变」就把计数吃掉。
    const docs = syncedCounter(0)
    let releaseQuery: (rows: RssEntry[]) => void = () => {}
    const query = () => new Promise<RssEntry[]>((resolve) => {
      releaseQuery = resolve
    })
    const list = useSyncedEntryList({ query, syncedDocs: docs.docs })

    const loading = list.load()
    docs.count.value = 3
    list.refreshFromSync()
    // 查询结果里没有那 3 条新内容（更旧的窗口）
    releaseQuery([makeEntry('z')])
    await loading

    expect(ids(list)).toEqual(['z'])
    expect(list.newCount.value).toBe(3)
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

  /**
   * 手动同步结束后的快捷路径（SyncButton 的 synced 事件）。
   *
   * 同步没带来任何新条目时可以顺手展开折叠着的「已同步 N 条」；只要本轮真的拉到了
   * 新条目、或同步没正常收尾，就必须维持「列表不动、等用户点查看」的原有行为。
   */
  describe('applyNewIfSyncAddedNothing（本轮没有新条目就顺手展开）', () => {
    const noNewEntries = { added: 0, failed: 0, cancelled: 0, storageBroken: false }

    /** 攒下 1 条待查看新条目的列表（此时列表仍停在旧快照） */
    async function listWithPending() {
      let rows = [makeEntry('b'), makeEntry('a')]
      const docs = syncedCounter(0)
      const query = vi.fn(async () => rows)
      const list = useSyncedEntryList({ query, syncedDocs: docs.docs })
      await list.load()

      // 后台/上一次同步拿进来 1 条新内容（c）
      rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
      docs.count.value = 1
      list.refreshFromSync()
      return { list, query }
    }

    it('本轮没有新条目 → 把攒着的待查看条目直接上屏并归零', async () => {
      const { list } = await listWithPending()
      expect(list.newCount.value).toBe(1)

      const applied = await list.applyNewIfSyncAddedNothing(noNewEntries)

      expect(applied).toBe(true)
      expect(ids(list)).toEqual(['c', 'b', 'a'])
      expect(list.newCount.value).toBe(0)
    })

    it('本轮拉到了新条目 → 列表一个字都不动，连查询都不发', async () => {
      const { list, query } = await listWithPending()
      const queriesBefore = query.mock.calls.length

      const applied = await list.applyNewIfSyncAddedNothing({ ...noNewEntries, added: 2 })

      expect(applied).toBe(false)
      expect(ids(list)).toEqual(['b', 'a']) // 正在读的内容没被推走
      expect(list.newCount.value).toBe(1)
      expect(query.mock.calls.length).toBe(queriesBefore)
    })

    it('没有折叠着的待查看条目 → 不重查也不回顶', async () => {
      const list = useSyncedEntryList({
        query: async () => [makeEntry('a')],
        syncedDocs: () => 0
      })
      await list.load()

      const applied = await list.applyNewIfSyncAddedNothing(noNewEntries)

      expect(applied).toBe(false)
      expect(ids(list)).toEqual(['a'])
    })

    // 手动同步的异常收尾只有两类：目标失败、本地存储熔断（暂停不再取消手动同步：
    // 服务端聚合已经跑完，取消它只会让用户的点击白费）
    const abortedOutcomes: Array<[string, SyncOutcomeLike]> = [
      ['有源失败', { added: 0, failed: 1, storageBroken: false }],
      ['本地存储熔断', { added: 0, failed: 0, storageBroken: true }]
    ]

    for (const [name, outcome] of abortedOutcomes) {
      it(`同步没有正常收尾（${name}）→ 不替用户改列表`, async () => {
        const { list } = await listWithPending()

        const applied = await list.applyNewIfSyncAddedNothing(outcome)

        expect(applied).toBe(false)
        expect(ids(list)).toEqual(['b', 'a'])
        expect(list.newCount.value).toBe(1)
      })
    }
  })
})
