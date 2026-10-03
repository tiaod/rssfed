import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'
import { DAY_MS } from '~/utils/syncWindow'

/**
 * 「进入具体列表 → 优先同步这个列表 → 再显示」与「同步窗口」的接线。
 *
 * 锁定四条规则：
 *   1. 优先同步把目标插到复制队列**最前面**（普通队列里排着几百个后台源）；
 *   2. 同一个库已有排队 / 在途任务时复用那一条（去重）—— 一遍页面切换不该发两份复制
 *      去写同一个 checkpoint；
 *   3. 等待有上限：超时不取消复制（页面先用本地缓存渲染，之后照旧弹「已同步 N 条」）；
 *      用户显式暂停时也不偷偷恢复；
 *   4. feed 库复制带同步窗口 selector，用户状态库不带；锚点落盘后跨轮保持一致
 *      （锚点一变，PouchDB 复制 id 就变，等于每天把所有源全量重扫一遍）。
 */

interface PendingTask {
  url: string
  /** replicate.from 的第二个参数：这里面才有 selector */
  opts: unknown
  finish: (result: { ok: boolean }) => void
  fail: (error: unknown) => void
}

const LNA = '2026-01-01T00:00:00.000Z'

const H = vi.hoisted(() => ({
  pending: [] as PendingTask[],
  replicateFrom: null as null | ((url: string, opts?: unknown) => unknown),
  remoteUrlForId: null as null | ((id: string) => Promise<string>),
  /** 远端订阅列表：syncPriority / syncNow 的增量过滤依据 */
  subscriptions: async () => [] as Array<{ feedId: string, lastNewEntryAt?: string }>
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string, opts?: unknown) => H.replicateFrom!(url, opts) }
    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
  }
  const statics = FakePouchDb as unknown as Record<string, unknown>
  statics.plugin = () => {}
  statics.allDbs = async () => []
  statics.destroy = async () => {}
  statics.sync = () => {
    const handle = { on: () => handle, cancel: () => {} }
    return handle
  }
  return { default: FakePouchDb }
})

vi.mock('pouchdb-find', () => ({ default: {} }))

vi.mock('~/utils/localDbName', () => ({
  localDbName: (kind: string, uid: string | null) => `fake-${kind}-${uid ?? 'guest'}`,
  syncedFeedsKey: (uid: string | null) => `rssfed-test-synced-${uid ?? 'guest'}`,
  syncRetryKey: (uid: string | null) => `rssfed-test-retry-${uid ?? 'guest'}`,
  syncWindowKey: (uid: string | null) => `rssfed-test-window-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  USER_STATE_ID: '__user_state__',
  useCouchTargets: () => ({
    remoteUrlForId: (id: string) => H.remoteUrlForId!(id),
    invalidate: () => {}
  })
}))

vi.mock('~/composables/useApi', () => ({
  // 转发而不是直接抓 H.subscriptions：usePouchDb 在创建时就把该函数闭包住了
  useApi: () => ({ feeds: { subscriptions: () => H.subscriptions() } })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'priority-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const WINDOW_KEY = 'rssfed-test-window-priority-test'
const SYNCED_KEY = 'rssfed-test-synced-priority-test'

let pouch: ReturnType<typeof usePouchDb>

/** 让所有在途任务立即成功，并等队列重新泵一轮（把新开跑的任务也收掉） */
async function drainAll() {
  for (let i = 0; i < 8; i++) {
    for (const task of [...H.pending]) task.finish({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  H.pending.length = 0
  H.remoteUrlForId = async (id: string) => `http://remote.test/${id}`
  H.subscriptions = async () => []
  H.replicateFrom = vi.fn((url: string, opts?: unknown) => {
    let finish!: (result: { ok: boolean }) => void
    let fail!: (error: unknown) => void
    const promise = new Promise<{ ok: boolean }>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const task = {
      // 让 replicateDb 的 `await task` 拿到复制结果
      then: (onFulfilled?: (v: { ok: boolean }) => unknown, onRejected?: (e: unknown) => unknown) =>
        promise.then(onFulfilled, onRejected),
      catch: (onRejected?: (e: unknown) => unknown) => promise.catch(onRejected),
      cancel: () => fail(new Error('cancelled'))
    }
    H.pending.push({ url, opts, finish, fail })
    return task
  })
  localStorage.clear()
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  // 账号对齐（与其它 usePouchDb 测试同规则）
  pouch.getUserStateDb()
})

describe('优先同步（进入列表时插队）', () => {
  it('等目标复制结束再返回；同库已有在途任务时复用（去重）', async () => {
    const round = pouch.syncFeedsIfChanged([{ feedId: 'feed-a', lastNewEntryAt: LNA }])
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))

    const priority = pouch.syncPriority(['feed-a'])
    await new Promise(resolve => setTimeout(resolve, 10))
    // 去重：没有再发第二条复制（两条并发复制会写同一个 checkpoint）
    expect(H.replicateFrom).toHaveBeenCalledTimes(1)

    H.pending[0]!.finish({ ok: true })
    await expect(priority).resolves.toEqual({ done: true, added: 0, skipped: 0 })
    await round
  })

  it('插到普通队列前面：普通源排队时，优先源先跑', async () => {
    void pouch.syncFeedsIfChanged(['n1', 'n2', 'n3'].map(id => ({ feedId: id, lastNewEntryAt: LNA })))
    // 并发上限 2：n1 / n2 在跑，n3 排队
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))

    const priority = pouch.syncPriority(['feed-p'], { waitMs: 200 })
    H.pending[0]!.finish({ ok: true })

    await vi.waitFor(() => expect(H.pending).toHaveLength(3))
    // 让出的并发位被优先源拿走，而不是排在队首的 n3
    expect(H.pending[2]!.url).toContain('/feed-p')

    await drainAll()
    await expect(priority).resolves.toMatchObject({ done: true })
  })

  it('已在普通队列里的源被提到最前', async () => {
    void pouch.syncFeedsIfChanged(['n1', 'n2', 'n3', 'n4'].map(id => ({ feedId: id, lastNewEntryAt: LNA })))
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))

    const priority = pouch.syncPriority(['n4'], { waitMs: 200 })
    H.pending[0]!.finish({ ok: true })

    await vi.waitFor(() => expect(H.pending).toHaveLength(3))
    expect(H.pending[2]!.url).toContain('/n4')

    await drainAll()
    await expect(priority).resolves.toMatchObject({ done: true })
  })

  it('超时不再等，但复制不取消（仍在后台跑）', async () => {
    const result = await pouch.syncPriority(['feed-a'], { waitMs: 20 })
    expect(result).toEqual({ done: false, added: 0, skipped: 0 })
    expect(H.pending).toHaveLength(1)
    expect(pouch.syncStatuses['feed-a']?.status).toBe('syncing')

    await drainAll()
    expect(pouch.syncStatuses['feed-a']?.status).toBe('idle')
  })

  it('远端没有新内容时直接返回（不排队、不发请求）', async () => {
    localStorage.setItem(SYNCED_KEY, JSON.stringify({ 'feed-a': { at: LNA, seen: LNA } }))
    H.subscriptions = async () => [{ feedId: 'feed-a', lastNewEntryAt: LNA }]

    const result = await pouch.syncPriority(['feed-a'], { waitMs: 1000 })
    expect(result).toEqual({ done: true, added: 0, skipped: 1 })
    expect(H.replicateFrom).not.toHaveBeenCalled()
  })

  it('用户已暂停同步时不动：暂停是显式动作，进列表不该偷偷恢复', async () => {
    pouch.pauseSync()
    const result = await pouch.syncPriority(['feed-a'], { waitMs: 50 })
    expect(result).toEqual({ done: true, added: 0, skipped: 1 })
    expect(H.replicateFrom).not.toHaveBeenCalled()
    expect(pouch.paused.value).toBe(true)
  })
})

describe('同步窗口 selector', () => {
  /** 取某次 replicate.from 的 selector */
  function selectorOf(index: number): Record<string, unknown> | undefined {
    return (H.pending[index]!.opts as { selector?: Record<string, unknown> }).selector
  }

  it('feed 库带窗口 selector，用户状态库不带', async () => {
    const round = pouch.syncNow(['feed-a', '__user_state__'])
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))

    const feed = H.pending.find(t => t.url.endsWith('/feed-a'))!
    const state = H.pending.find(t => t.url.endsWith('/__user_state__'))!
    const selector = (feed.opts as { selector?: { $or: unknown[] } }).selector!
    expect(selector.$or[0]).toEqual({ type: 'feed' })

    const anchor = (selector.$or[1] as { publishedAt: { $gte: string } }).publishedAt.$gte
    // 默认窗口 3 天：锚点落在 now - 3 天附近
    expect(Math.abs(Date.parse(anchor) - (Date.now() - 3 * DAY_MS))).toBeLessThan(10_000)
    // 用户状态库装的是订阅关系与已读/收藏，没有条目时间可过滤
    expect((state.opts as { selector?: unknown }).selector).toBeUndefined()

    // 锚点落盘（它必须跨会话稳定，见 utils/syncWindow）
    expect(JSON.parse(localStorage.getItem(WINDOW_KEY)!)['feed-a|3']).toBe(anchor)

    await drainAll()
    await round
  })

  it('时间前进一天后仍用同一个锚点（否则每天全量重扫一遍）', async () => {
    // 第一轮带上服务端 lastNewEntryAt，好让水位表记下 seen 值（下一轮的增量判据）
    H.subscriptions = async () => [{ feedId: 'feed-a', lastNewEntryAt: LNA }]
    const first = pouch.syncNow(['feed-a'])
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const firstSelector = JSON.stringify(selectorOf(0))
    H.pending[0]!.finish({ ok: true })
    await first

    H.pending.length = 0
    const now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + DAY_MS)
    try {
      // 远端 lastNewEntryAt 变了才会重新入队
      void pouch.syncFeedsIfChanged([{ feedId: 'feed-a', lastNewEntryAt: '2026-02-02T00:00:00.000Z' }])
      await vi.waitFor(() => expect(H.pending).toHaveLength(1))
      expect(JSON.stringify(selectorOf(0))).toBe(firstSelector)
    } finally {
      nowSpy.mockRestore()
    }
    await drainAll()
  })

  it('不限时间（0）时不加 selector，退回改动前的全量复制', async () => {
    localStorage.setItem('app-settings', JSON.stringify({ syncWindowDays: 0 }))
    const round = pouch.syncNow(['feed-a'])
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    expect(selectorOf(0)).toBeUndefined()

    H.pending[0]!.finish({ ok: true })
    await round
  })

  it('重置本地缓存会清掉窗口锚点：窗口从重置那一刻重新起算', async () => {
    const round = pouch.syncNow(['feed-a'])
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })
    await round
    expect(localStorage.getItem(WINDOW_KEY)).toBeTruthy()

    await pouch.resetLocalData()
    expect(localStorage.getItem(WINDOW_KEY)).toBeNull()
  })
})
