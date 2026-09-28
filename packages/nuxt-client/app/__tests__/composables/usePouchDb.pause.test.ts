import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 「暂停同步」的底层行为（左下角指示器点击暂停时走的那条路）。
 *
 * 关注三件事：
 *   1. 暂停要真的停下来：在途复制被取消、排队任务被清空，结果以 cancelled 上报（不算失败）；
 *   2. 暂停期间自动同步不再入队（不发请求），归位为 idle 且不递增 version（不触发列表重查）；
 *   3. 用户主动点同步（syncNow）即视为恢复。
 *
 * 这里用假的 PouchDB：复制的 Promise 由测试控制何时完成 / 取消，才能稳定复现「同步途中暂停」。
 */

interface PendingTask {
  url: string
  cancel: () => void
  finish: (result: { ok: boolean }) => void
}

const H = vi.hoisted(() => ({
  pending: [] as PendingTask[],
  replicateFrom: null as null | ((url: string) => unknown),
  remoteUrlForId: null as null | ((id: string) => Promise<string>)
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string) => H.replicateFrom!(url) }
    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
  }
  const statics = FakePouchDb as unknown as Record<string, unknown>
  statics.plugin = () => {}
  statics.allDbs = async () => []
  statics.destroy = async () => {}
  // 用户状态库的 live 同步（PouchDB.sync）：给一个可链式 on() 且能 cancel 的空壳
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
  useApi: () => ({ feeds: { subscriptions: vi.fn(async () => []) } })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'pause-test' } })
}))

// Nuxt auto-import：共享状态挂在 nuxtApp 单例上，这里必须每次返回同一个对象
const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.pending.length = 0
  H.remoteUrlForId = async (id: string) => `http://remote.test/${id}`
  H.replicateFrom = vi.fn((url: string) => {
    let finish!: (result: { ok: boolean }) => void
    let fail!: (error: unknown) => void
    const promise = new Promise<{ ok: boolean }>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    // 模拟 PouchDB 的复制任务：await 得结果，cancel() 让 Promise 以错误 reject
    const task = {
      then: (onFulfilled?: (v: { ok: boolean }) => unknown, onRejected?: (e: unknown) => unknown) =>
        promise.then(onFulfilled, onRejected),
      catch: (onRejected?: (e: unknown) => unknown) => promise.catch(onRejected),
      cancel: () => fail(new Error('cancelled'))
    }
    H.pending.push({ url, cancel: task.cancel, finish })
    return task
  })

  // 每个用例都从干净的共享状态开始
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  // 模拟「进入页面时账号已就位」：真实应用里同步前已经读过用户状态库（如侧边栏订阅列表），
  // 本地库与账号已完成对齐；否则首次 getEntriesDb() 内的 switchUser 会让这次复制的归属账号判空
  pouch.getUserStateDb()
})

describe('暂停同步（usePouchDb）', () => {
  it('暂停：取消在途复制、清空排队任务，结果按 cancelled 上报', async () => {
    // 三个目标、并发上限 2：前两个在跑，第三个排队
    const syncPromise = pouch.syncNow(['feed-a', 'feed-b', 'feed-c'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))
    expect(pouch.syncStatuses['feed-c']?.status).toBe('queued')

    pouch.pauseSync()

    const result = await syncPromise
    expect(result.cancelled).toBe(3)
    expect(result.ok).toEqual([])
    // 暂停不是失败：不写 error 状态、不产生失败项（否则会弹「同步失败」）
    expect(result.failed).toEqual([])
    expect(pouch.syncStatuses['feed-a']?.status).toBe('idle')
    expect(pouch.syncStatuses['feed-b']?.status).toBe('idle')
    expect(pouch.syncStatuses['feed-c']?.status).toBe('idle')
    expect(pouch.paused.value).toBe(true)
  })

  it('暂停归位不递增同步版本（不触发列表重查）', async () => {
    const syncPromise = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    const before = pouch.syncStatuses['feed-a']?.version
    expect(before).toBe(0)

    pouch.pauseSync()
    await syncPromise

    expect(pouch.syncStatuses['feed-a']?.version).toBe(0)
  })

  it('暂停期间：自动同步不再入队（不发复制请求）', async () => {
    pouch.pauseSync()

    expect(await pouch.syncFeedsIfChanged([{ feedId: 'feed-a' }])).toBe(0)
    pouch.syncFeed('feed-b')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(H.replicateFrom).not.toHaveBeenCalled()
  })

  it('暂停发生在取库名期间：不再发起复制（此时任务已出队，取消不到它）', async () => {
    let release!: () => void
    H.remoteUrlForId = (id: string) => new Promise<string>((resolve) => {
      release = () => resolve(`http://remote.test/${id}`)
    })

    const syncPromise = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(typeof release).toBe('function'))

    // 寻址请求还在途中时用户点了暂停：任务已经被移出队列，只能靠 replicateDb 自己检查
    pouch.pauseSync()
    release()

    const result = await syncPromise
    expect(result.cancelled).toBe(1)
    expect(H.replicateFrom).not.toHaveBeenCalled()
    expect(pouch.syncStatuses['feed-a']?.status).toBe('idle')
  })

  it('暂停状态下调用 syncNow（用户点同步）= 恢复并正常拉取', async () => {
    pouch.pauseSync()

    const syncPromise = pouch.syncNow(['feed-a'], { full: true })
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    expect(pouch.paused.value).toBe(false)

    H.pending[0]!.finish({ ok: true })
    const result = await syncPromise

    expect(result.ok).toEqual(['feed-a'])
    expect(result.cancelled).toBe(0)
    expect(pouch.syncStatuses['feed-a']?.status).toBe('idle')
    expect(pouch.syncStatuses['feed-a']?.lastSyncedAt).toBeTruthy()
  })
})
