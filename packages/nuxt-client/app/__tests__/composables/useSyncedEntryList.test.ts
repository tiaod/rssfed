import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useSyncedEntryList } from '../../composables/useSyncedEntryList'
import type { RssEntry } from '../../types/rss'

// 复刻 Nuxt auto-import：composable 内部直接引用全局 ref
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref

// 复刻 Nuxt 应用级 state：同 key 的多次读取读写同一个槽位，用来模拟页面切走再点回来
const nuxtState = new Map<string, unknown>()
nuxtGlobals.useState = <T>(key: string, init?: () => T) => {
  if (!nuxtState.has(key)) nuxtState.set(key, init ? init() : null)
  return {
    get value(): T {
      return nuxtState.get(key) as T
    },
    set value(next: T) {
      nuxtState.set(key, next)
    }
  }
}

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

describe('useSyncedEntryList', () => {
  beforeEach(() => {
    // applyPending 会滚回列表顶部；测试不关心滚动，替换掉避免依赖 happy-dom 实现
    window.scrollTo = (() => {}) as typeof window.scrollTo
    nuxtState.clear()
  })

  it('首屏加载直接上屏，不产生提示', async () => {
    const list = useSyncedEntryList({ query: async () => [makeEntry('c'), makeEntry('b')] })

    await list.load()

    expect(ids(list)).toEqual(['c', 'b'])
    expect(list.pendingCount.value).toBe(0)
    // 返回条数未达窗口上限 → 没有更多
    expect(list.hasMore.value).toBe(false)
  })

  it('列表已有内容后，同步拿到头部新条目：不上屏、只提示，用户点击后才上屏', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync()

    // 正在读的列表没被推动（不管用户此刻滚到哪，新条目都先收纳）
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

  it('用户主动点同步按钮：新条目直接上屏', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync(true)

    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('用户主动同步只放行那一次，之后的新条目照样先收纳', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const list = useSyncedEntryList({ query: async () => rows })
    await list.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync(true)
    expect(ids(list)).toEqual(['c', 'b', 'a'])

    // 同步收尾阶段又有源完成，带来新条目 d
    rows = [makeEntry('d'), makeEntry('c'), makeEntry('b'), makeEntry('a')]
    await list.refreshFromSync()

    expect(ids(list)).toEqual(['c', 'b', 'a'])
    expect(list.pendingCount.value).toBe(1)
  })

  it('加载更多时头部未确认的新条目不会顺带上屏，只接上尾部扩展', async () => {
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

describe('useSyncedEntryList 列表快照（切走再回来）', () => {
  beforeEach(() => {
    window.scrollTo = (() => {}) as typeof window.scrollTo
    nuxtState.clear()
    sessionStorage.clear()
  })

  it('重新进入列表时恢复上次内容，期间同步到的新条目进提示条', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()
    expect(ids(before)).toEqual(['b', 'a'])

    // 离开页面，期间同步到了新条目 c；再点回时间线（组件重新挂载）
    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })

    // 挂载即恢复上次列表（因此也不需要 loading 遮罩）
    expect(ids(after)).toEqual(['b', 'a'])

    await after.load()

    // 页面刚挂载时滚动位置必在顶部，但这里是「回来接着读」，新条目不该直接插进列表
    expect(ids(after)).toEqual(['b', 'a'])
    expect(after.pendingCount.value).toBe(1)

    after.applyPending()
    expect(ids(after)).toEqual(['c', 'b', 'a'])
    expect(after.pendingCount.value).toBe(0)
  })

  it('首次进入（没有快照）时首屏照常直接上屏', async () => {
    const list = useSyncedEntryList({
      query: async () => [makeEntry('b'), makeEntry('a')],
      stateKey: 'timeline'
    })

    await list.load()

    expect(ids(list)).toEqual(['b', 'a'])
    expect(list.pendingCount.value).toBe(0)
  })

  it('换账号后不复用上一个账号的列表快照', async () => {
    nuxtState.set('auth-session-user', { id: 'user-a' })
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()

    // 换账号后本地库也换了一批条目
    nuxtState.set('auth-session-user', { id: 'user-b' })
    rows = [makeEntry('y'), makeEntry('x')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()

    expect(ids(after)).toEqual(['y', 'x'])
    expect(after.pendingCount.value).toBe(0)
  })

  it('数据源整批换掉时直接按新内容上屏，不把快照内容拼进来', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()

    // 同一账号但条目被整批替换（本地库重建）：一条都对不上
    rows = [makeEntry('y'), makeEntry('x')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()

    expect(ids(after)).toEqual(['y', 'x'])
    expect(after.pendingCount.value).toBe(0)
  })

  it('用户主动同步时把恢复的列表换成最新内容', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()

    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()
    expect(after.pendingCount.value).toBe(1)

    // 用户点了同步按钮：他此刻就是要看最新内容
    await after.refreshFromSync(true)

    expect(ids(after)).toEqual(['c', 'b', 'a'])
    expect(after.pendingCount.value).toBe(0)
  })
})

describe('useSyncedEntryList 刷新恢复（落盘阅读基准）', () => {
  beforeEach(() => {
    window.scrollTo = (() => {}) as typeof window.scrollTo
    nuxtState.clear()
    sessionStorage.clear()
  })

  it('整页刷新后（内存快照没了）仍把新条目收进提示条', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()
    expect(ids(before)).toEqual(['b', 'a'])

    // 刷新：Nuxt 应用级 state 清空，只剩 sessionStorage 里的阅读基准
    nuxtState.clear()
    rows = [makeEntry('c'), makeEntry('b'), makeEntry('a')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()

    // 摆回来的是刷新前那批内容，新条目在提示条里
    expect(ids(after)).toEqual(['b', 'a'])
    expect(after.pendingCount.value).toBe(1)

    after.applyPending()
    expect(ids(after)).toEqual(['c', 'b', 'a'])
  })

  it('刷新恢复时放大窗口重查，列表不会因为切掉新条目而变短', async () => {
    const old = ['old-0', 'old-1', 'old-2'].map(makeEntry)
    let rows = [...old]
    // 真实 query 会按 limit 截断窗口
    const query = async (limit: number) => rows.slice(0, limit)
    const before = useSyncedEntryList({ query, stateKey: 'feed:x', pageSize: 3 })
    await before.load()
    expect(ids(before)).toEqual(['old-0', 'old-1', 'old-2'])

    nuxtState.clear()
    rows = [makeEntry('new-0'), makeEntry('new-1'), ...old, makeEntry('older-0')]
    const after = useSyncedEntryList({ query, stateKey: 'feed:x', pageSize: 3 })
    await after.load()

    // 2 条新内容进提示条，列表仍是完整一页（放大到 5 条后切出基准起的 3 条）
    expect(ids(after)).toEqual(['old-0', 'old-1', 'old-2'])
    expect(after.pendingCount.value).toBe(2)
  })

  it('基准条目已不在本地库时退回常规上屏，不会一直卡着', async () => {
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()

    nuxtState.clear()
    rows = [makeEntry('y'), makeEntry('x')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()

    expect(ids(after)).toEqual(['y', 'x'])
    expect(after.pendingCount.value).toBe(0)
  })

  it('换账号后不认上一个账号的阅读基准', async () => {
    nuxtState.set('auth-session-user', { id: 'user-a' })
    let rows = [makeEntry('b'), makeEntry('a')]
    const before = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await before.load()

    // 刷新 + 换账号：本地库与基准归属都对不上
    nuxtState.clear()
    nuxtState.set('auth-session-user', { id: 'user-b' })
    rows = [makeEntry('y'), makeEntry('x')]
    const after = useSyncedEntryList({ query: async () => rows, stateKey: 'timeline' })
    await after.load()

    expect(ids(after)).toEqual(['y', 'x'])
  })
})
