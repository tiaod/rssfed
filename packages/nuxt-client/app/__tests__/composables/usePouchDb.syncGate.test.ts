import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 自动同步入口（`syncFeedsIfChanged`）的闸门行为。
 *
 * 服务端聚合之后，「要不要同步某个源」由服务端判断（reconcile 内部一条 SQL），
 * 客户端只负责两件事：确保 live 复制在跑、**带节流地**催一次聚合。于是这里锁定：
 *   1. 有订阅 → 催一次（并挂上 live 复制）；
 *   2. 节流窗口内重复调用不再打接口（页面反复挂载 / 用户反复刷新都不该每次都请求）；
 *   3. 空订阅、用户暂停、存储熔断 → 什么都不做；
 *   4. `syncFeed`（显式动作，如刚订阅完）不受节流限制；
 *   5. `resetLocalData` 清空本地库与同步状态，并重新挂上 live 复制。
 */

interface FakeTask {
  url: string
  cancelled: boolean
  emitError: (err: unknown) => void
}

const H = vi.hoisted(() => ({
  /** 服务端下发的远端聚合库地址（换库用例会改它；null = 取不到地址，模拟离线/后端不可达） */
  remoteUrl: 'http://remote.test/timeline' as string | null,
  /** 取寻址被调用了几次（离线时它必须远小于 getEntriesDb 的调用次数） */
  remoteUrlCalls: 0,
  tasks: [] as FakeTask[],
  refreshArgs: [] as unknown[][],
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number }
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string) => makeTask(url), to: () => makePushHandle() }
    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
  }

  /**
   * 状态回写通道（push）不参与这些用例的断言：它们关心的都是拉取通道的生命周期与事件。
   * 这里返回一个不记录的句柄，避免 H.tasks 里混进第二条任务、把 H.tasks[0] 的语义搞乱。
   */
  function makePushHandle() {
    const handle = { on: () => handle, cancel: () => {}, removeListener: () => handle, then: () => handle }
    return handle
  }

  function makeTask(url: string) {
    const listeners = new Map<string, Set<(arg: unknown) => void>>()
    let cancelled = false
    const task = {
      on: (event: string, fn: (arg: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(fn)
        return task
      },
      removeListener: () => task,
      cancel: () => {
        cancelled = true
      },
      then: () => task
    }
    H.tasks.push({
      url,
      get cancelled() {
        return cancelled
      },
      emitError: err => listeners.get('error')?.forEach(fn => fn(err))
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
  localDbName: (uid: string | null) => `fake-${uid ?? 'guest'}`,
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
  lastTimelineUrlKey: (uid: string | null) => `rssfed-test-url-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: async (id: string) => {
      H.remoteUrlCalls++
      return id === '__timeline__' ? H.remoteUrl : null
    },
    dbNameFor: async (id: string) => (id === '__timeline__' ? H.remoteUrl : null),
    invalidate: () => {}
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: async () => [] },
    timeline: {
      refresh: (...args: unknown[]) => {
        H.refreshArgs.push(args)
        return H.refresh()
      }
    }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'syncgate-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const TIMELINE_ID = '__timeline__'
// 只有 feedId 有意义：syncFeedsIfChanged 现在只用数组长度判空（见 usePouchDb）
const FEEDS = [{ feedId: 'feed-a' }]
let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.remoteUrl = 'http://remote.test/timeline'
  H.remoteUrlCalls = 0
  H.tasks.length = 0
  H.refreshArgs.length = 0
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  // 单库方案下不再需要预先创建本地库：条目与状态同一个库，第一次真正用到时懒建。
  // （若在这里先取库，会顺带挂上一条 live 复制，把「没有订阅/已暂停时不该挂复制」这类用例的
  //  H.tasks 断言搅乱。）
})

describe('自动同步（syncFeedsIfChanged）', () => {
  it('有订阅：催一次服务端聚合（即发即忘、不带 wait），并挂上时间线 live 复制', async () => {
    const count = await pouch.syncFeedsIfChanged(FEEDS)
    expect(count).toBe(1)
    // 即发即忘（不传 wait）：催一次就返回，数据靠 live 复制到端
    expect(H.refreshArgs).toEqual([[undefined]])
    expect(H.tasks).toHaveLength(1)
    expect(H.tasks[0]!.url).toContain('timeline')
  })

  it('节流窗口内重复调用不再打接口（但仍确保 live 复制在跑）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    await pouch.syncFeedsIfChanged(FEEDS)
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshArgs).toHaveLength(1)
    expect(H.tasks).toHaveLength(1)
  })

  it('syncFeed（显式动作）不受节流限制', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.syncFeed()
    await vi.waitFor(() => expect(H.refreshArgs).toHaveLength(2))
  })

  it('没有订阅：不催、不挂复制', async () => {
    expect(await pouch.syncFeedsIfChanged([])).toBe(0)
    expect(H.refreshArgs).toHaveLength(0)
    expect(H.tasks).toHaveLength(0)
  })

  it('用户暂停时不动：暂停是显式动作，进页面不该偷偷恢复', async () => {
    pouch.pauseSync()
    expect(await pouch.syncFeedsIfChanged(FEEDS)).toBe(0)
    expect(H.refreshArgs).toHaveLength(0)
    expect(H.tasks).toHaveLength(0)
  })

  it('本地存储熔断后不再催、不再挂复制', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    H.tasks[0]!.emitError({ name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })
    expect(pouch.storageBroken.value).toBeTruthy()

    expect(await pouch.syncFeedsIfChanged(FEEDS)).toBe(0)
    expect(H.refreshArgs).toHaveLength(1)
    expect(H.tasks).toHaveLength(1)
  })
})

describe('挂载失败后的退避（sync-targets 请求风暴的根因）', () => {
  it('取不到远端地址时只重试一次，后续取库不再重复取地址', async () => {
    H.remoteUrl = null
    // 复现首屏：41 次并发取库 —— 旧实现里每一次都会重走一遍「取寻址 → 失败」
    await Promise.all(Array.from({ length: 41 }, () => pouch.getUserDb()))

    // 全部落在同一次挂载流程里（并发复用 timelineSyncPromise），退避记下之后不再重试
    expect(H.remoteUrlCalls).toBe(1)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('error')
  })

  it('退避窗口内再取库也不重试（不再是每次 getEntriesDb 一次请求）', async () => {
    H.remoteUrl = null
    await pouch.getUserDb()
    expect(H.remoteUrlCalls).toBe(1)

    for (let i = 0; i < 40; i++) await pouch.getUserDb()
    expect(H.remoteUrlCalls).toBe(1)
  })

  it('恢复联网（online 事件）后立刻重试，不必等退避走完', async () => {
    H.remoteUrl = null
    await pouch.getUserDb()
    expect(H.remoteUrlCalls).toBe(1)
    const tasksBefore = H.tasks.length
    expect(tasksBefore).toBe(0)

    // 后端恢复 + 浏览器发出 online → 清退避并重挂，得到真正的复制通道。
    // （online 监听挂在 window 上、按 nuxtApp 状态各注册一份；本文件每个用例都是一个新状态，
    //  所以这里按「本次派发之后新挂上的那条通道」断言，而不是 H.tasks 的总数。）
    H.remoteUrl = 'http://remote.test/timeline'
    globalThis.window?.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(H.remoteUrlCalls).toBe(2))
    await vi.waitFor(() => expect(H.tasks.length).toBeGreaterThan(tasksBefore))
    expect(H.tasks.at(-1)!.url).toBe('http://remote.test/timeline')
  })

  it('显式重挂（ensureTimelineLiveSync(true)）不受退避约束', async () => {
    H.remoteUrl = null
    await pouch.getUserDb()
    expect(H.remoteUrlCalls).toBe(1)

    H.remoteUrl = 'http://remote.test/timeline'
    await pouch.ensureTimelineLiveSync(true)
    expect(H.remoteUrlCalls).toBe(2)
    expect(H.tasks).toHaveLength(1)
  })
})

describe('resetLocalData', () => {
  it('清空同步计数与状态，并重新挂上 live 复制', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.tasks).toHaveLength(1)

    await pouch.resetLocalData()

    // 旧句柄被取消，新句柄挂上（本地库已重建，必须从头复制一次）
    expect(H.tasks[0]!.cancelled).toBe(true)
    expect(H.tasks).toHaveLength(2)
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBeUndefined()
  })

  it('重置同时解除存储熔断（重建本地库就是修复动作）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    H.tasks[0]!.emitError({ name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })
    expect(pouch.storageBroken.value).toBeTruthy()

    await pouch.resetLocalData()
    expect(pouch.storageBroken.value).toBeNull()
    expect(H.tasks).toHaveLength(2)
  })
})

describe('远端聚合库被换掉（重建 / v1→v2 升级）', () => {
  const URL_KEY = 'rssfed-test-url-syncgate-test'

  it('首次同步：记下这次同步的远端地址', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)

    expect(H.tasks).toHaveLength(1)
    expect(localStorage.getItem(URL_KEY)).toBe('http://remote.test/timeline')
  })

  it('地址没变：接着同步，不丢本地缓存', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    await pouch.ensureTimelineLiveSync(true)

    // 只多挂了一条（旧的那条被停掉），没有因为"换库"多清一次本地库
    expect(H.tasks).toHaveLength(2)
    expect(H.tasks.filter(t => t.cancelled)).toHaveLength(1)
    expect(localStorage.getItem(URL_KEY)).toBe('http://remote.test/timeline')
  })

  it('地址变了：丢掉本地旧镜像、按新库重新全量拉一遍（旧修订谱系会让新库内容变成冲突分支）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.tasks).toHaveLength(1)

    // 服务端换库：新地址
    H.remoteUrl = 'http://remote.test/timeline-2'
    await pouch.ensureTimelineLiveSync(true)

    // 旧句柄被取消，新句柄指向新库；记账也跟着更新（否则会来回判"换库"）
    expect(H.tasks[0]!.cancelled).toBe(true)
    expect(H.tasks.at(-1)!.url).toBe('http://remote.test/timeline-2')
    expect(localStorage.getItem(URL_KEY)).toBe('http://remote.test/timeline-2')
    // 同步状态被重置（本地库已重建，计数从零开始）
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBeUndefined()
  })
})
