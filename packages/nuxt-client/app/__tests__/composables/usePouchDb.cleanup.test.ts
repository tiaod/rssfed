import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 旧本地库清理（`cleanupLegacyDbs`）的**发起时机**。
 *
 * 背景：清理要 `indexedDB.databases()` + `deleteDatabase` + `new PouchDB(旧名).destroy()`，
 * 全是重 IO，与首屏的 `db.query` 抢同一批事务（实测把 queryTimeline 从 ~60ms 拉到 ~180ms）。
 * 所以它被挪出首屏关键路径，改成「排进空闲窗口」。
 *
 * 这里锁定四件事：
 *   1. 取库（`getUserDb()` → `getEntriesDb()`）只**排**清理，不发起（首屏期间迁移标记不会被写上）；
 *   2. 空闲窗口到了才真的跑，且全程只跑一次；
 *   3. 首屏那几十次取库只排一个任务（幂等）；
 *   4. 需要「清理确实做完」的地方（`syncFeedsIfChanged`）仍然 await 得到。
 */

const H = vi.hoisted(() => ({
  /** `PouchDB.allDbs()` 被调了几次：清理真正开跑才会碰它（见 destroyLegacyLocalDbs 的回退分支） */
  allDbsCalls: 0,
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number }
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = {
      from: () => makeHandle(),
      to: () => makeHandle()
    }

    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
    put = async () => ({ ok: true })
    compact = async () => ({ ok: true })
  }
  function makeHandle() {
    const handle = { on: () => handle, cancel: () => {}, removeListener: () => handle, then: () => handle }
    return handle
  }
  const statics = FakePouchDb as unknown as Record<string, unknown>
  statics.plugin = () => {}
  statics.allDbs = async () => {
    H.allDbsCalls++
    return []
  }
  statics.destroy = async () => {}
  return { default: FakePouchDb }
})

vi.mock('pouchdb-find', () => ({ default: {} }))

vi.mock('~/utils/localDbName', () => ({
  localDbName: (uid: string | null) => `fake-${uid ?? 'guest'}`,
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
  // 清理逻辑真的会读这两个：空列表 = 没有要删的旧库，但清理流程本身照常跑
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: async (id: string) => `http://remote.test/${id}`,
    invalidate: () => {}
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: async () => [] },
    timeline: { refresh: () => H.refresh() }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'cleanup-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

/** 迁移标记：清理跑完才会写（见 cleanupLegacyDbs 的 v5 标记） */
const MIGRATED_KEY = 'rssfed-central-migrated-v5'
/** 与 usePouchDb 里「无 requestIdleCallback 时的回退延迟」保持一致 */
const FALLBACK_DELAY_MS = 2000

/** 冲一遍微任务，让被排上的异步清理跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.allDbsCalls = 0
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  vi.useFakeTimers()
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'requestIdleCallback')
})

describe('旧库清理被排进空闲窗口（不挡首屏）', () => {
  it('取库只排清理、不发起：首屏期间迁移标记不会被写上', async () => {
    await pouch.getUserDb()
    await flush()

    // 清理还没跑：没有碰 IndexedDB 的枚举，也没写迁移标记
    expect(H.allDbsCalls).toBe(0)
    expect(localStorage.getItem(MIGRATED_KEY)).toBeNull()
  })

  it('空闲窗口到了才真的跑（回退定时器）', async () => {
    await pouch.getUserDb()
    expect(localStorage.getItem(MIGRATED_KEY)).toBeNull()

    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS + 10)
    await flush()

    expect(H.allDbsCalls).toBe(1)
    expect(localStorage.getItem(MIGRATED_KEY)).toBe('1')
  })

  it('首屏几十次取库只排一个任务、只跑一次', async () => {
    // 复现首屏：41 次并发取库（清理若不幂等，这里就是 41 次删库）
    await Promise.all(Array.from({ length: 41 }, () => pouch.getUserDb()))
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS + 10)
    await flush()

    expect(H.allDbsCalls).toBe(1)

    // 之后再取库也不会重排（本会话已清理过）
    await pouch.getUserDb()
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS + 10)
    await flush()
    expect(H.allDbsCalls).toBe(1)
  })

  it('浏览器有 requestIdleCallback 时用它，而不是 setTimeout', async () => {
    const idleCallbacks: Array<() => void> = []
    const requestIdleCallback = vi.fn((cb: () => void) => {
      idleCallbacks.push(cb)
      return idleCallbacks.length
    })
    Object.defineProperty(globalThis, 'requestIdleCallback', {
      value: requestIdleCallback,
      configurable: true,
      writable: true
    })

    await pouch.getUserDb()
    expect(requestIdleCallback).toHaveBeenCalledTimes(1)

    // 空闲回调没被调用前，清理不会跑
    expect(H.allDbsCalls).toBe(0)
    idleCallbacks[0]!()
    await flush()
    expect(H.allDbsCalls).toBe(1)
  })

  it('syncFeedsIfChanged 仍会等清理完成（需要它做完的调用点语义不变）', async () => {
    await pouch.syncFeedsIfChanged([{ feedId: 'feed-a' }])
    // 它显式 await 了 ensureCleanup：返回时清理已经跑过（而不是排着队）
    expect(localStorage.getItem(MIGRATED_KEY)).toBe('1')
  })

  it('清理由空闲窗口跑完之后不再重复（幂等）', async () => {
    await pouch.getUserDb()
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS + 10)
    await flush()
    expect(H.allDbsCalls).toBe(1)

    // 再排一次（换页后新闭包取库）也不会重跑
    H.allDbsCalls = 0
    await pouch.getUserDb()
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS + 10)
    await flush()
    expect(H.allDbsCalls).toBe(0)
  })
})
