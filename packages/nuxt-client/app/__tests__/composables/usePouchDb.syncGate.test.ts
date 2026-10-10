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
  /** 服务端下发的远端聚合库地址（换库用例会改它） */
  remoteUrl: 'http://remote.test/timeline',
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
  lastTimelineUrlKey: (uid: string | null) => `rssfed-test-url-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: async (id: string) => (id === '__timeline__' ? H.remoteUrl : null),
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
const FEEDS = [{ feedId: 'feed-a', lastNewEntryAt: '2026-01-01T00:00:00.000Z' }]
let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.remoteUrl = 'http://remote.test/timeline'
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
