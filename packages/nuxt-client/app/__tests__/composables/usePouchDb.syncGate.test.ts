import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 同步闸门（增量水位 / 失败退避 / 存储故障熔断）的集成行为。
 *
 * 背景：线上现象是「每次打开时间线都有几百个源要同步，实际有内容的只有几十个」。
 * 根因是复制失败后不记录任何东西 —— 下一轮仍被判为「从未同步过」而全量重试，
 * 几百个源反复砸在同一块坏掉的 IndexedDB 库上。
 *
 * 本文件锁定三条规则：
 *   1. 成功 → 写 v2 水位（含服务端 seen 值），同一 lastNewEntryAt 下一轮不再入队；
 *   2. 失败 → 写退避表，退避窗口内不再重试；
 *   3. 存储故障（indexed_db_went_bad / QuotaExceededError）→ 熔断本轮，
 *      队列清空、剩下的源不再发起，且按「没尝试」而不是「失败」上报。
 */

interface PendingTask {
  url: string
  cancel: () => void
  finish: (result: { ok: boolean }) => void
  fail: (error: unknown) => void
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
  useApi: () => ({ feeds: { subscriptions: vi.fn(async () => []) } })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'gate-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const SYNCED_KEY = 'rssfed-test-synced-gate-test'
const RETRY_KEY = 'rssfed-test-retry-gate-test'

let pouch: ReturnType<typeof usePouchDb>

function readSynced(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(SYNCED_KEY) ?? '{}')
}

function readRetry(): Record<string, { attempts: number, lastAttemptAt: string }> {
  return JSON.parse(localStorage.getItem(RETRY_KEY) ?? '{}')
}

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
    const task = {
      then: (onFulfilled?: (v: { ok: boolean }) => unknown, onRejected?: (e: unknown) => unknown) =>
        promise.then(onFulfilled, onRejected),
      catch: (onRejected?: (e: unknown) => unknown) => promise.catch(onRejected),
      cancel: () => fail(new Error('cancelled'))
    }
    H.pending.push({ url, cancel: task.cancel, finish, fail })
    return task
  })

  localStorage.clear()
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  // 账号对齐（真实应用里同步前已经读过用户状态库，避免首次 getEntriesDb 内的 switchUser 影响归属）
  pouch.getUserStateDb()
})

describe('增量水位：成功后才推进，且记录服务端 seen 值', () => {
  it('同步成功写 v2 水位，同一 lastNewEntryAt 下一轮不再入队', async () => {
    const lna = '2026-01-01T00:00:00.000Z'
    const feeds = [{ feedId: 'feed-a', lastNewEntryAt: lna }]

    expect(await pouch.syncFeedsIfChanged(feeds)).toBe(1)
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })

    await vi.waitFor(() => {
      expect(readSynced()['feed-a']).toMatchObject({ seen: lna })
    })

    // 第二轮：服务端值没变 → 不入队，也没有新的复制请求
    expect(await pouch.syncFeedsIfChanged(feeds)).toBe(0)
    expect(H.replicateFrom).toHaveBeenCalledTimes(1)
  })

  it('服务端 lastNewEntryAt 变了 → 需要同步', async () => {
    const feeds = [{ feedId: 'feed-a', lastNewEntryAt: '2026-01-01T00:00:00.000Z' }]
    await pouch.syncFeedsIfChanged(feeds)
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })
    await vi.waitFor(() => expect(readSynced()['feed-a']).toBeTruthy())

    expect(await pouch.syncFeedsIfChanged([{ feedId: 'feed-a', lastNewEntryAt: '2026-01-02T00:00:00.000Z' }])).toBe(1)
    // 第二次复制确实发起了（pending 里累积第一条 + 第二条）
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))
    expect(H.replicateFrom).toHaveBeenCalledTimes(2)
  })
})

describe('失败退避：失败后不再每轮全量重试', () => {
  it('复制失败写入退避表，紧接着的下一轮跳过该源', async () => {
    const feeds = [{ feedId: 'feed-a', lastNewEntryAt: '2026-01-01T00:00:00.000Z' }]

    await pouch.syncFeedsIfChanged(feeds)
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.fail(new Error('network down'))

    await vi.waitFor(() => {
      expect(readRetry()['feed-a']?.attempts).toBe(1)
    })
    // 水位没被推进（失败不算同步过）
    expect(readSynced()['feed-a']).toBeUndefined()

    // 退避窗口内：不再入队，不再发复制请求
    expect(await pouch.syncFeedsIfChanged(feeds)).toBe(0)
    expect(H.replicateFrom).toHaveBeenCalledTimes(1)
  })

  it('同步成功后清掉退避记录', async () => {
    localStorage.setItem(RETRY_KEY, JSON.stringify({ 'feed-a': { attempts: 5, lastAttemptAt: '2020-01-01T00:00:00.000Z' } }))
    const feeds = [{ feedId: 'feed-a', lastNewEntryAt: '2026-01-01T00:00:00.000Z' }]

    // 退避时间早已过期 → 允许重试
    expect(await pouch.syncFeedsIfChanged(feeds)).toBe(1)
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.finish({ ok: true })

    await vi.waitFor(() => {
      expect(readRetry()['feed-a']).toBeUndefined()
    })
  })
})

describe('存储故障熔断', () => {
  it('IndexedDB 配额故障：置位 storageBroken，队列清空且不再发起复制', async () => {
    // 60 个源一次性全入队：验证首批故障后剩下的都不再发起请求
    const feeds = Array.from({ length: 60 }, (_, i) => ({
      feedId: `feed-${i}`,
      lastNewEntryAt: '2026-01-01T00:00:00.000Z'
    }))

    expect(await pouch.syncFeedsIfChanged(feeds)).toBe(60)
    // 并发上限 2：只会先跑两个，其余在队列里排队
    await vi.waitFor(() => expect(H.pending).toHaveLength(2))

    H.pending[0]!.fail({ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })
    await vi.waitFor(() => expect(pouch.storageBroken.value).toBeTruthy())
    expect(pouch.storageBroken.value).toContain('本地缓存写入失败')

    const callsAfterBreak = (H.replicateFrom as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 30))

    // 队列里排队的 58 个在熔断时被清空（按 cancelled 回执，不是失败）
    expect((H.replicateFrom as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterBreak)
    expect(callsAfterBreak).toBeLessThanOrEqual(2)

    // 熔断后即便再调用（例如切回页面），也不会入队
    await pouch.syncFeedsIfChanged(feeds)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((H.replicateFrom as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterBreak)

    // 熔断整轮按「没尝试」上报：几百条失败项会淹没真正的原因（storageBroken 有自己的提示）
    const result = await pouch.syncNow(['feed-0'], { full: true })
    expect(result.cancelled).toBe(1)
    expect(result.failed).toEqual([])
  })

  it('重置本地缓存后解除熔断，并清掉退避与水位记录', async () => {
    const feeds = [{ feedId: 'feed-a', lastNewEntryAt: '2026-01-01T00:00:00.000Z' }]
    await pouch.syncFeedsIfChanged(feeds)
    await vi.waitFor(() => expect(H.pending).toHaveLength(1))
    H.pending[0]!.fail({ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })
    await vi.waitFor(() => expect(pouch.storageBroken.value).toBeTruthy())
    await vi.waitFor(() => expect(readRetry()['feed-a']).toBeTruthy())

    await pouch.resetLocalData()

    expect(pouch.storageBroken.value).toBeNull()
    expect(localStorage.getItem(SYNCED_KEY)).toBeNull()
    expect(localStorage.getItem(RETRY_KEY)).toBeNull()
  })
})
