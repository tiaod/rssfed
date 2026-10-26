import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'
import { COMPACT_IDLE_DELAY_MS, COMPACT_MIN_INTERVAL_MS } from '~/utils/localCompact'

/**
 * 「同步空闲后压缩本地库」的接线。
 *
 * 关注四件事：
 *   1. 复制安静下来（paused）后**等一段时间**才压，且一天只压一次；
 *   2. 用户暂停 / 同步又忙起来时不压（那是无效的 IO 争抢）；
 *   3. 压缩失败不冒错、不写节流记录 —— 下一轮空闲还能再试；
 *   4. 压缩不该动同步状态（压缩不改变文档内容，列表没有重查的必要）。
 *
 * 判定门槛本身由 utils/localCompact 的单测覆盖，这里只验证「什么时候被调用」。
 */

interface FakeTask {
  url: string
  direction: 'pull' | 'push'
  cancelled: boolean
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
  listenerCount: (event: string) => number
}

const H = vi.hoisted(() => ({
  tasks: [] as FakeTask[],
  compactCalls: 0,
  compactImpl: async (): Promise<void> => {},
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number }
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = {
      from: (url: string) => makeTask(url, 'pull'),
      to: (url: string) => makeTask(url, 'push')
    }

    compact = async () => {
      H.compactCalls++
      await H.compactImpl()
      return { ok: true }
    }

    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
  }
  function makeTask(url: string, direction: 'pull' | 'push') {
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
    const emit = (event: string, arg?: unknown) => listeners.get(event)?.forEach(fn => fn(arg))
    H.tasks.push({
      url,
      direction,
      get cancelled() {
        return cancelled
      },
      emitChange: info => emit('change', info),
      emitPaused: () => emit('paused'),
      listenerCount: event => listeners.get(event)?.size ?? 0
    })
    return task
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
  localDbAccountKey: (uid: string | null) => uid ?? 'guest',
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
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
    timeline: {
      refresh: () => H.refresh()
    }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'compact-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const TIMELINE_ID = '__timeline__'
const FEEDS = [{ feedId: 'feed-a' }]
/** 压缩节流记录（与上面的 localDbName mock 保持一致） */
const COMPACT_KEY = 'rssfed-test-compacted-compact-test'

function tasksOf(direction: 'pull' | 'push'): FakeTask[] {
  return H.tasks.filter(t => t.direction === direction)
}

function pullTask(): FakeTask {
  const task = tasksOf('pull').at(-1)
  if (!task) throw new Error('拉取通道尚未挂上')
  return task
}

/** 等被 setTimeout 排上的异步压缩跑完（fake timers 下推进时间后再冲一遍微任务） */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.tasks.length = 0
  H.compactCalls = 0
  H.compactImpl = async () => {}
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  vi.useFakeTimers()
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  pouch.getUserDb()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('空闲压缩（usePouchDb）', () => {
  it('复制安静下来 30 秒后压缩一次，并记下时间', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()

    expect(H.compactCalls).toBe(1)
    expect(Number(localStorage.getItem(COMPACT_KEY))).toBeGreaterThan(0)
  })

  it('一天之内不再压第二次', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(1)

    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(1)
  })

  it('距上次压缩超过一天后，下一轮空闲会再压一次', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(1)

    vi.setSystemTime(Date.now() + COMPACT_MIN_INTERVAL_MS + 1000)
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(2)
  })

  it('用户暂停同步：取消已经排上的压缩', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    pouch.pauseSync()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(0)
  })

  it('计时期间同步又忙起来：这轮不压（等下一轮空闲）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    const pull = pullTask()
    pull.emitPaused()
    pull.emitChange({ docs_written: 5, pending: 2 })
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()
    expect(H.compactCalls).toBe(0)
  })

  it('压缩失败不冒错、不写节流记录（下次空闲还能再试）', async () => {
    H.compactImpl = async () => {
      throw new Error('IndexedDB 挂了')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()

    expect(H.compactCalls).toBe(1)
    expect(localStorage.getItem(COMPACT_KEY)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('压缩不改变同步状态（不递增 version、不把 idle 改回去）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pullTask().emitPaused()
    const before = { ...pouch.syncStatuses[TIMELINE_ID]! }

    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + 10)
    await flush()

    expect(H.compactCalls).toBe(1)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.version).toBe(before.version)
  })
})
