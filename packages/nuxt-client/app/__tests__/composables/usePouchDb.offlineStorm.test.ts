import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 离线冷启动的 `sync-targets` 请求风暴（回归测试，对应 report/offline-probe 的实测）。
 *
 * 实测：离线冷启动一次打开 /timeline，`pouch:getEntriesDb` 在首屏期间被调用 **41 次**，
 * 而每次取库都会 `void ensureTimelineLiveSync()`。旧实现里「挂载失败 → 没留下句柄 →
 * 下一次取库再取一遍寻址」，于是 41 次取库放大成 31~38 个注定失败的 sync-targets 请求
 * （每个还带 credentials，离线时要等浏览器网络栈报错）。
 *
 * 这里**不 mock useCouchTargets**：要验证的正是「库名缓存 + 失败退避」与「挂载失败退避」
 * 这两层合起来之后的真实请求次数。
 */

const H = vi.hoisted(() => ({
  /** 被拦截到的 sync-targets 请求 */
  requests: [] as string[]
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
  statics.allDbs = async () => []
  statics.destroy = async () => {}
  return { default: FakePouchDb }
})

vi.mock('pouchdb-find', () => ({ default: {} }))

vi.mock('~/utils/localDbName', () => ({
  localDbName: (uid: string | null) => `fake-${uid ?? 'guest'}`,
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
  lastTimelineUrlKey: (uid: string | null) => `rssfed-test-url-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: async () => [] },
    timeline: {
      // 离线时催促也失败
      refresh: async () => {
        throw new Error('Failed to fetch')
      }
    }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'storm-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp
testGlobals.useRuntimeConfig = () => ({ public: { apiBaseUrl: 'http://localhost:3001' } })

/** 首屏期间实际观察到的取库次数（见 report/offline-probe） */
const FIRST_PAINT_GET_DB_CALLS = 41

const realFetch = globalThis.fetch

function setOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    value: online,
    configurable: true,
    writable: true
  })
}

beforeEach(() => {
  H.requests.length = 0
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  vi.resetModules()
  // 后端不可达：所有请求都以 TypeError: Failed to fetch 失败（与离线实测一致）
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    H.requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
})

afterEach(() => {
  globalThis.fetch = realFetch
  setOnline(true)
})

describe('离线冷启动：sync-targets 请求次数', () => {
  it('浏览器自认离线：首屏 41 次取库一个 sync-targets 请求都不发', async () => {
    setOnline(false)
    // resetModules 之后要重新 import，模块级缓存（库名 / 失败退避）才是干净的
    const { usePouchDb: freshUsePouchDb } = await import('~/composables/usePouchDb')
    const pouch = freshUsePouchDb()

    await Promise.all(Array.from({ length: FIRST_PAINT_GET_DB_CALLS }, () => pouch.getUserDb()))

    // 离线短路：连浏览器网络栈都不碰（旧实现这里是 31~38 个失败请求）
    expect(H.requests).toHaveLength(0)
  })

  it('浏览器自认在线但后端不可达：失败被记住，只打一次（而不是 41 次）', async () => {
    setOnline(true)
    const { usePouchDb: freshUsePouchDb } = await import('~/composables/usePouchDb')
    const pouch = freshUsePouchDb()

    // 逐个 await 取库：正是首屏那条「取库 → 查询 → 再取库」的串行调用形态
    for (let i = 0; i < FIRST_PAINT_GET_DB_CALLS; i++) await pouch.getUserDb()

    const syncTargetRequests = H.requests.filter(url => url.includes('/api/couchdb/sync-targets'))
    expect(syncTargetRequests).toHaveLength(1)
    // 同步状态如实报错（不是静默失败）
    expect(pouch.syncStatuses.__timeline__?.status).toBe('error')
  })

  it('离线时 syncPriority 立即返回，不等满 5s（首屏不被空等拖住）', async () => {
    setOnline(false)
    const { usePouchDb: freshUsePouchDb } = await import('~/composables/usePouchDb')
    const pouch = freshUsePouchDb()

    const started = Date.now()
    const result = await pouch.syncPriority()
    expect(Date.now() - started).toBeLessThan(200)
    expect(result.done).toBe(false)
    expect(result.skipped).toBe(1)
  })
})
