import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 「暂停同步」的底层行为（左下角指示器点击暂停时走的那条路）。
 *
 * 关注四件事：
 *   1. 暂停要真的停下来：时间线 live 复制被取消（否则服务端一有新条目又自动拉进来）；
 *   2. 暂停归位为 idle 且不递增 version（不触发列表重查）；
 *   3. 暂停期间自动同步不再催、不再挂复制；迟到的复制事件也不再改状态；
 *   4. 用户主动点同步（syncNow）即视为恢复。
 *
 * 注意用户状态库（已读/收藏）的 live 双向同步**不**受影响：暂停拉新条目不该停掉状态回写。
 */

interface FakeTask {
  url: string
  cancelled: boolean
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
}

const H = vi.hoisted(() => ({
  tasks: [] as FakeTask[],
  refreshCalls: 0,
  /** 用户状态库的 live 双向同步句柄被取消过几次 */
  stateSyncCancels: 0,
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number }
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string) => makeTask(url) }
    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
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
    const emit = (event: string, arg?: unknown) => listeners.get(event)?.forEach(fn => fn(arg))
    H.tasks.push({
      url,
      get cancelled() {
        return cancelled
      },
      emitChange: info => emit('change', info),
      emitPaused: () => emit('paused')
    })
    return task
  }
  const statics = FakePouchDb as unknown as Record<string, unknown>
  statics.plugin = () => {}
  statics.allDbs = async () => []
  statics.destroy = async () => {}
  statics.sync = () => {
    const handle = {
      on: () => handle,
      cancel: () => {
        H.stateSyncCancels++
      }
    }
    return handle
  }
  return { default: FakePouchDb }
})

vi.mock('pouchdb-find', () => ({ default: {} }))

vi.mock('~/utils/localDbName', () => ({
  localDbName: (kind: string, uid: string | null) => `fake-${kind}-${uid ?? 'guest'}`,
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  USER_STATE_ID: '__user_state__',
  useCouchTargets: () => ({
    remoteUrlForId: async (id: string) => `http://remote.test/${id}`,
    invalidate: () => {}
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: async () => [] },
    timeline: {
      refresh: () => {
        H.refreshCalls++
        return H.refresh()
      }
    }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'pause-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const TIMELINE_ID = '__timeline__'
const FEEDS = [{ feedId: 'feed-a' }]
let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.tasks.length = 0
  H.refreshCalls = 0
  H.stateSyncCancels = 0
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  pouch.getUserStateDb()
})

describe('暂停同步（usePouchDb）', () => {
  it('暂停：取消时间线 live 复制，状态归位 idle 且不递增 version', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    const version = pouch.syncStatuses[TIMELINE_ID]!.version
    H.tasks[0]!.emitChange({ docs_written: 10, pending: 5 })

    pouch.pauseSync()

    expect(H.tasks[0]!.cancelled).toBe(true)
    expect(pouch.paused.value).toBe(true)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.version).toBe(version)
  })

  it('暂停后迟到的复制事件不再改状态（代次已变）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.pauseSync()
    H.tasks[0]!.emitChange({ docs_written: 99, pending: 1 })
    H.tasks[0]!.emitPaused()
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.progress).toBeUndefined()
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBeUndefined()
  })

  it('暂停期间：自动同步既不催聚合，也不挂复制', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(1)
    expect(H.tasks).toHaveLength(1)

    pouch.pauseSync()
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(1)
    expect(H.tasks).toHaveLength(1)
  })

  it('暂停不停用户状态库的 live 双向同步（已读/收藏的实时通道）', () => {
    pouch.getUserStateDb()
    pouch.pauseSync()
    expect(H.stateSyncCancels).toBe(0)
  })

  it('恢复同步：重新挂上 live 复制，并可再次催聚合', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.pauseSync()
    pouch.resumeSync()
    expect(pouch.paused.value).toBe(false)
    await vi.waitFor(() => expect(H.tasks).toHaveLength(2))
    expect(H.tasks[1]!.cancelled).toBe(false)

    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(2)
  })

  it('暂停状态下点同步（syncNow）= 恢复并正常拉取', async () => {
    pouch.pauseSync()
    H.refresh = async () => ({ accepted: true, completed: true, added: 3 })
    const pending = pouch.syncNow()
    await vi.waitFor(() => expect(H.tasks).toHaveLength(1))
    H.tasks[0]!.emitChange({ docs_written: 3, pending: 0 })
    H.tasks[0]!.emitPaused()
    const result = await pending

    expect(pouch.paused.value).toBe(false)
    expect(result.added).toBe(3)
    expect(result.failed).toHaveLength(0)
  })
})
