import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 单源复制进度（change 事件）与同步状态机的接线。
 *
 * 三条不变量：
 *   1. 复制的 `change` 事件要能把源内进度推进到 syncStatuses 上（进度条 / 弹层据此展示）；
 *   2. **不能**在 change 里递增 version —— 列表页 watch 到 version 变化就重查条目，
 *      每批都重查会让长同步期间的列表反复抖动；
 *   3. 复制结束后状态回到 idle，且不留 progress 字段（否则进度条会把已完成的库
 *      当成一次进行中的复制重复计入）。
 *
 * 用假 PouchDB：任务是一个可手动 emit 的事件对象，才能稳定复现「拉到一半」。
 */

interface FakeTask {
  url: string
  finish: (result: { ok: boolean }) => void
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  listenerCount: () => number
}

const H = vi.hoisted(() => ({
  pending: [] as FakeTask[],
  remoteUrlForId: null as null | ((id: string) => Promise<string>),
  /** 远端订阅列表（含 lastNewEntryAt）：syncNow 的增量过滤依据，用例可替换 */
  subscriptions: async () => [] as Array<{ feedId: string, lastNewEntryAt?: string }>
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string) => makeTask(url) }
    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
  }
  // PouchDB 的 Replication 继承自 EventEmitter：这里只需要 change 的订阅与退订
  function makeTask(url: string) {
    let finish!: (result: { ok: boolean }) => void
    const promise = new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve
    })
    const listeners = new Set<(info: { docs_written?: number, pending?: number }) => void>()
    const task = {
      url,
      // 让 replicateDb 的 `await task` 拿到复制结果
      then: (onFulfilled?: (v: { ok: boolean }) => unknown, onRejected?: (e: unknown) => unknown) =>
        promise.then(onFulfilled, onRejected),
      catch: (onRejected?: (e: unknown) => unknown) => promise.catch(onRejected),
      on: (event: string, fn: (info: { docs_written?: number, pending?: number }) => void) => {
        if (event === 'change') listeners.add(fn)
      },
      removeListener: (event: string, fn: (info: { docs_written?: number, pending?: number }) => void) => {
        if (event === 'change') listeners.delete(fn)
      },
      cancel: () => {}
    }
    H.pending.push({
      url,
      finish,
      emitChange: info => listeners.forEach(fn => fn(info)),
      listenerCount: () => listeners.size
    })
    return task
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
  // 转发而不是直接引用 H.subscriptions：usePouchDb 在创建时就把该函数抓进闭包，
  // 用例体内再替换 H.subscriptions 也要能生效
  useApi: () => ({ feeds: { subscriptions: () => H.subscriptions() } })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'progress-test' } })
}))

// Nuxt auto-import：共享状态挂在 nuxtApp 单例上，这里必须每次返回同一个对象
const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.pending.length = 0
  H.remoteUrlForId = async (id: string) => `http://remote.test/${id}`
  H.subscriptions = async () => []
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  // 对齐账号（同 pause 测试：真实应用在同步前已读过用户状态库）
  pouch.getUserStateDb()
})

describe('单源复制进度（usePouchDb）', () => {
  it('change 事件把源内进度推进到 syncStatuses，且不递增 version', async () => {
    const syncPromise = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const task = H.pending[0]!

    expect(pouch.syncStatuses['feed-a']?.status).toBe('syncing')
    // 进度从 0 起算：还没写入任何文档时不能说「已拉完」
    expect(pouch.syncStatuses['feed-a']?.progress).toBe(0)

    task.emitChange({ docs_written: 20, pending: 80 })
    expect(pouch.syncStatuses['feed-a']?.progress).toBe(20)
    expect(pouch.syncStatuses['feed-a']?.docsWritten).toBe(20)
    expect(pouch.syncStatuses['feed-a']?.pending).toBe(80)
    // version 是「列表该重查了」的信号，必须等复制完成才 +1
    expect(pouch.syncStatuses['feed-a']?.version).toBe(0)

    task.emitChange({ docs_written: 60, pending: 20 })
    expect(pouch.syncStatuses['feed-a']?.progress).toBe(75)
    expect(pouch.syncStatuses['feed-a']?.version).toBe(0)

    task.finish({ ok: true })
    await syncPromise
    // 完成后归位 idle：progress 等字段必须清掉，否则进度条会把已完成的库重复计入
    expect(pouch.syncStatuses['feed-a']?.status).toBe('idle')
    expect(pouch.syncStatuses['feed-a']?.version).toBe(1)
    expect(pouch.syncStatuses['feed-a']?.progress).toBeUndefined()
    expect(pouch.syncStatuses['feed-a']?.docsWritten).toBeUndefined()
    // 监听器要摘掉：任务句柄结束后不该再持有这轮复制的闭包
    expect(task.listenerCount()).toBe(0)
  })

  it('缺 pending 的 change 不改变进度（降级为上一次的值）', async () => {
    const syncPromise = pouch.syncNow(['feed-b'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const task = H.pending[0]!

    task.emitChange({ docs_written: 20, pending: 80 })
    expect(pouch.syncStatuses['feed-b']?.progress).toBe(20)
    // 服务端（或代理）没给 pending 时不能把进度顶到 100%
    task.emitChange({ docs_written: 40 })
    expect(pouch.syncStatuses['feed-b']?.progress).toBe(20)

    task.finish({ ok: true })
    await syncPromise
  })

  it('进度满了（pending: 0）但任务还没结束：状态仍是 syncing，等 complete 才归位', async () => {
    const syncPromise = pouch.syncNow(['feed-c'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const task = H.pending[0]!

    task.emitChange({ docs_written: 100, pending: 0 })
    expect(pouch.syncStatuses['feed-c']?.progress).toBe(100)
    // 进度 100 不等于复制结束：checkpoint 还没写完，此时清状态会让进度条提前消失
    expect(pouch.syncStatuses['feed-c']?.status).toBe('syncing')

    task.finish({ ok: true })
    await syncPromise
    expect(pouch.syncStatuses['feed-c']?.status).toBe('idle')
  })

  it('暂停后迟到的 change 不会把归位的状态改回 syncing', async () => {
    const syncPromise = pouch.syncNow(['feed-d'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const task = H.pending[0]!

    pouch.pauseSync()
    // 假任务没有真实取消语义：这里手动模拟「cancel 后仍有在途响应回调」
    task.emitChange({ docs_written: 50, pending: 50 })
    expect(pouch.syncStatuses['feed-d']?.status).toBe('idle')

    task.finish({ ok: true })
    const result = await syncPromise
    // 暂停已把任务标记为取消，`await task` 之后按 cancelled 上报（不算失败）
    expect(result.cancelled).toBe(1)
  })
})

/**
 * 「已同步 N 条」的记账：列表页把它显示成提示条，条数来自复制 change 事件的 docs_written。
 * 这份计数只增不减，且必须和 version 同一时刻落地 —— 列表页 watch 到 version 变化时读的
 * 就是它。
 */
describe('已同步条数（syncedDocsByFeed）', () => {
  it('复制成功后按 change 报出的累计写入数记账，两次同步依次累加', async () => {
    const first = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const task = H.pending[0]!
    // docs_written 是本次复制的累计值：最后一次就是总数，不能把 20 + 60 加起来
    task.emitChange({ docs_written: 20, pending: 80 })
    task.emitChange({ docs_written: 60, pending: 20 })
    task.finish({ ok: true })
    await first

    expect(pouch.syncedDocsByFeed['feed-a']).toBe(60)

    const second = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))
    H.pending[1]!.emitChange({ docs_written: 5, pending: 0 })
    H.pending[1]!.finish({ ok: true })
    await second

    expect(pouch.syncedDocsByFeed['feed-a']).toBe(65)
  })

  it('复制失败不记账（用户看到的「已同步」不能报未落库的条数）', async () => {
    const failed = pouch.syncNow(['feed-b'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.emitChange({ docs_written: 10, pending: 0 })
    H.pending[0]!.finish({ ok: false })
    await failed

    expect(pouch.syncedDocsByFeed['feed-b']).toBeUndefined()
  })

  it('没有写入的复制不记账', async () => {
    const none = pouch.syncNow(['feed-c'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })
    await none

    expect(pouch.syncedDocsByFeed['feed-c']).toBeUndefined()
  })
})

/**
 * syncNow 的 added（本轮真正写入本地的文档数）：列表页拿它判断「这次点同步有没有带来
 * 新条目」——为 0 时才会顺手把折叠着的「已同步 N 条」展开上屏。
 */
describe('syncNow 的本轮写入数（added）', () => {
  it('按目标前后差值报出本轮写入的文档数', async () => {
    const syncPromise = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.emitChange({ docs_written: 3, pending: 0 })
    H.pending[0]!.finish({ ok: true })

    const result = await syncPromise

    expect(result.added).toBe(3)
    expect(pouch.syncedDocsByFeed['feed-a']).toBe(3)
  })

  it('复制成功但没有写入任何文档 → added 为 0（不算「有新条目」）', async () => {
    const syncPromise = pouch.syncNow(['feed-b'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })

    const result = await syncPromise

    expect(result.ok).toEqual(['feed-b'])
    expect(result.added).toBe(0)
  })

  it('源全部被增量过滤跳过（按钮瞬时完成）→ 不发复制、added 为 0', async () => {
    // 远端该源没有新条目（lastNewEntryAt 缺失）→ needsSync 为假，整轮没有目标
    H.subscriptions = async () => [{ feedId: 'feed-skip', lastNewEntryAt: '' }]

    const result = await pouch.syncNow(['feed-skip'])

    expect(result).toEqual({ ok: [], failed: [], skipped: 1, cancelled: 0, added: 0 })
    expect(H.pending).toHaveLength(0)
  })
})
