import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 「暂停同步」的底层行为（左下角指示器点击暂停时走的那条路）。
 *
 * 关注四件事：
 *   1. 暂停要真的停下来：拉取通道被取消（否则服务端一有新条目又自动拉进来）；
 *   2. 暂停归位为 idle 且不递增 version（不触发列表重查）；
 *   3. 暂停期间自动同步不再催、不再挂复制；迟到的复制事件也不再改状态；
 *   4. 用户主动点同步（syncNow）即视为恢复。
 *
 * 注意**状态回写通道不**受影响：暂停拉新条目不该停掉已读/收藏的回写。
 * 单库方案下一个远端库配两条通道（pull + 带过滤的 push），所以每次挂载会多出一个任务。
 */

interface FakeTask {
  url: string
  /** 'pull' = 拉取通道，'push' = 状态回写通道 */
  direction: 'pull' | 'push'
  cancelled: boolean
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
}

const H = vi.hoisted(() => ({
  tasks: [] as FakeTask[],
  refreshCalls: 0,
  /** 状态回写通道被取消过几次（暂停不该动它，换账号/重置才该动） */
  pushCancels: 0,
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number }
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = {
      from: (url: string) => makeTask(url, 'pull'),
      to: (url: string) => makeTask(url, 'push')
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
        if (direction === 'push') H.pushCancels++
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
      emitPaused: () => emit('paused')
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
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
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

/** 按通道类型取已挂上的任务（每次挂载会同时挂 pull 与 push） */
function tasksOf(direction: 'pull' | 'push'): FakeTask[] {
  return H.tasks.filter(t => t.direction === direction)
}

/**
 * 最近一次挂载的拉取通道。
 *
 * 必须取**最后**一个：beforeEach 里的首次取库也会挂一次，暂停把它取消后又重挂，
 * 发事件发到已被取消的那条（回调因代次变化被丢弃）会让用例白等到超时。
 */
function pullTask(): FakeTask {
  const task = tasksOf('pull').at(-1)
  if (!task) throw new Error('拉取通道尚未挂上')
  return task
}
let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
  H.tasks.length = 0
  H.refreshCalls = 0
  H.pushCancels = 0
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  pouch.getUserDb()
})

describe('暂停同步（usePouchDb）', () => {
  it('暂停：取消时间线 live 复制，状态归位 idle 且不递增 version', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    const version = pouch.syncStatuses[TIMELINE_ID]!.version
    pullTask().emitChange({ docs_written: 10, pending: 5 })

    pouch.pauseSync()

    expect(pullTask().cancelled).toBe(true)
    expect(pouch.paused.value).toBe(true)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.version).toBe(version)
  })

  it('暂停后迟到的复制事件不再改状态（代次已变）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.pauseSync()
    pullTask().emitChange({ docs_written: 99, pending: 1 })
    pullTask().emitPaused()
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.progress).toBeUndefined()
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBeUndefined()
  })

  it('暂停期间：自动同步既不催聚合，也不挂复制', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(1)
    expect(tasksOf('pull')).toHaveLength(1)
    expect(tasksOf('push')).toHaveLength(1)

    pouch.pauseSync()
    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(1)
    // 暂停期间不再新挂通道（既不挂拉取也不再挂回写）
    expect(tasksOf('pull')).toHaveLength(1)
    expect(tasksOf('push')).toHaveLength(1)
  })

  it('暂停不停状态回写通道（已读/收藏的实时通道）', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.pauseSync()
    expect(H.pushCancels).toBe(0)
    expect(tasksOf('push')[0]!.cancelled).toBe(false)
  })

  it('恢复同步：重新挂上 live 复制，并可再次催聚合', async () => {
    await pouch.syncFeedsIfChanged(FEEDS)
    pouch.pauseSync()
    pouch.resumeSync()
    expect(pouch.paused.value).toBe(false)
    await vi.waitFor(() => expect(tasksOf('pull')).toHaveLength(2))
    expect(tasksOf('pull')[1]!.cancelled).toBe(false)

    await pouch.syncFeedsIfChanged(FEEDS)
    expect(H.refreshCalls).toBe(2)
  })

  it('暂停状态下点同步（syncNow）= 恢复并正常拉取', async () => {
    pouch.pauseSync()
    H.refresh = async () => ({ accepted: true, completed: true, added: 3 })
    const mountsBefore = tasksOf('pull').length
    const pending = pouch.syncNow()
    await vi.waitFor(() => expect(tasksOf('pull').length).toBeGreaterThan(mountsBefore))
    const pull = pullTask()
    // 等挂载整段跑完（状态落到 idle）再发事件：处理器是在挂载末尾注册的
    await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.status).toBe('idle'))
    // 先发 change 确认通道活着，再发 paused —— 避免「事件先于 catchup 基准值」的顺序竞争
    pull.emitChange({ docs_written: 3, pending: 0 })
    await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.status).toBe('syncing'))
    pull.emitPaused()
    const result = await pending

    expect(pouch.paused.value).toBe(false)
    expect(result.added).toBe(3)
    expect(result.failed).toHaveLength(0)
  })
})
