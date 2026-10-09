import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 时间线 live 复制的进度与同步状态机。
 *
 * 服务端聚合之后客户端只有一条 live 复制（时间线库单向），所以这里盯的不变量是：
 *   1. `change` 事件把进度写进 syncStatuses，但**不递增 version** —— 列表页 watch version
 *      就重查条目，每批都重查会让同步期间列表反复抖动；
 *   2. 复制安静下来（`paused`）才收尾：把本批真正写入的文档数记进「已同步 N 条」并 +1 version；
 *   3. **没有写入的那次 paused 不递增 version**（打开应用、服务端没新内容时 live 复制同样会
 *      安静一次，照样递增就会让每个列表白重查一遍）；
 *   4. 存储故障（配额/库损坏）必须主动停掉 live 复制并置位 storageBroken ——
 *      否则 live 的 retry 会无限重试，一直砸在同一块坏掉的库上。
 *
 * 用假 PouchDB：live 任务是一个可手动 emit 事件的对象，才能稳定复现「拉到一半 / 刚安静下来」。
 */

interface FakeTask {
  url: string
  cancelled: boolean
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
  emitError: (err: unknown) => void
  listenerCount: (event: string) => number
}

const H = vi.hoisted(() => ({
  tasks: [] as FakeTask[],
  /** 催促聚合的假实现（用例可替换，返回 completed/added） */
  refresh: async () => ({ accepted: true, completed: true, added: 0 }) as { accepted: boolean, completed?: boolean, added?: number },
  refreshCalls: 0,
  remoteUrlForId: null as null | ((id: string) => Promise<string | null>)
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = { from: (url: string, _opts?: unknown) => makeTask(url), to: () => makePushHandle() }
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
      removeListener: (event: string, fn: (arg: unknown) => void) => {
        listeners.get(event)?.delete(fn)
        return task
      },
      cancel: () => {
        cancelled = true
      },
      // live 复制的 Promise 要到会话结束才 resolve；给一个永不变更的 then 贴近真实行为
      then: () => task
    }
    const emit = (event: string, arg?: unknown) => listeners.get(event)?.forEach(fn => fn(arg))
    H.tasks.push({
      url,
      get cancelled() {
        return cancelled
      },
      emitChange: info => emit('change', info),
      emitPaused: () => emit('paused'),
      emitError: err => emit('error', err),
      listenerCount: event => listeners.get(event)?.size ?? 0
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
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: (id: string) => H.remoteUrlForId!(id),
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
  useUserStore: () => ({ user: { id: 'progress-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const TIMELINE_ID = '__timeline__'
let pouch: ReturnType<typeof usePouchDb>

/** 触发一次「自动同步」，把 live 复制挂上 */
async function startLive() {
  await pouch.syncFeedsIfChanged([{ feedId: 'feed-a' }])
}

beforeEach(() => {
  H.tasks.length = 0
  H.refreshCalls = 0
  H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
  H.remoteUrlForId = async (id: string) => (id === TIMELINE_ID ? 'http://remote.test/timeline' : null)
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  pouch.getUserDb()
})

describe('时间线 live 复制：进度与状态', () => {
  it('change 事件推进进度，但不递增 version', async () => {
    await startLive()
    expect(H.tasks).toHaveLength(1)
    const before = pouch.syncStatuses[TIMELINE_ID]!.version

    H.tasks[0]!.emitChange({ docs_written: 20, pending: 80 })
    const status = pouch.syncStatuses[TIMELINE_ID]!
    expect(status.status).toBe('syncing')
    expect(status.progress).toBe(20)
    expect(status.docsWritten).toBe(20)
    expect(status.pending).toBe(80)
    expect(status.version).toBe(before)
  })

  it('缺 pending 的 change 不改变进度（降级为上一次的值）', async () => {
    await startLive()
    H.tasks[0]!.emitChange({ docs_written: 40, pending: 60 })
    expect(pouch.syncStatuses[TIMELINE_ID]!.progress).toBe(40)
    H.tasks[0]!.emitChange({ docs_written: 45 })
    expect(pouch.syncStatuses[TIMELINE_ID]!.progress).toBe(40)
  })

  it('安静下来（paused）才收尾：记账 + 递增 version + 状态归位 idle', async () => {
    await startLive()
    const version = pouch.syncStatuses[TIMELINE_ID]!.version

    H.tasks[0]!.emitChange({ docs_written: 60, pending: 0 })
    H.tasks[0]!.emitPaused()

    const status = pouch.syncStatuses[TIMELINE_ID]!
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBe(60)
    expect(status.status).toBe('idle')
    expect(status.version).toBe(version + 1)
    expect(status.progress).toBeUndefined()
    expect(status.lastSyncedAt).toBeTruthy()
  })

  it('docs_written 是本次复制的累计值：第二批只按差值记账', async () => {
    await startLive()
    H.tasks[0]!.emitChange({ docs_written: 60, pending: 0 })
    H.tasks[0]!.emitPaused()
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBe(60)

    // 服务端又推了 3 条：累计值从 60 涨到 63，差值才是这一批
    H.tasks[0]!.emitChange({ docs_written: 63, pending: 0 })
    H.tasks[0]!.emitPaused()
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBe(63)
    expect(pouch.syncStatuses[TIMELINE_ID]!.version).toBe(2)
  })

  it('没有写入的那次 paused 不记账、不递增 version（否则每个列表都白重查一遍）', async () => {
    await startLive()
    const version = pouch.syncStatuses[TIMELINE_ID]!.version
    H.tasks[0]!.emitPaused()
    H.tasks[0]!.emitPaused()
    expect(pouch.syncedDocsByTarget[TIMELINE_ID]).toBeUndefined()
    expect(pouch.syncStatuses[TIMELINE_ID]!.version).toBe(version)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
  })

  it('存储故障：置位 storageBroken 并停掉 live 复制（不再无限重试）', async () => {
    await startLive()
    H.tasks[0]!.emitError({ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })
    expect(pouch.storageBroken.value).toBeTruthy()
    expect(H.tasks[0]!.cancelled).toBe(true)
    // 熔断后不再挂新的 live 复制
    await pouch.syncFeedsIfChanged([{ feedId: 'feed-a' }])
    expect(H.tasks).toHaveLength(1)
  })

  it('普通错误只写 error 状态，不熔断', async () => {
    await startLive()
    H.tasks[0]!.emitError(new Error('network down'))
    expect(pouch.storageBroken.value).toBeNull()
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('error')
    expect(pouch.syncStatuses[TIMELINE_ID]!.error).toContain('network down')
    expect(H.tasks[0]!.cancelled).toBe(false)
  })
})

describe('syncNow 的新增条数', () => {
  it('服务端报新增 N 条：等 live 复制把 N 条落地后 added=N', async () => {
    H.refresh = async () => ({ accepted: true, completed: true, added: 5 })
    const pending = pouch.syncNow()
    // 等 live 复制挂上（resumeSync 会先挂，syncNow 再等它）。
    // 挂载函数在挂完两条通道后才注册事件处理器：等状态落到 idle 再发事件，
    // 否则事件发在注册之前会被假任务丢掉，用例只能白等到超时
    await vi.waitFor(() => expect(H.tasks).toHaveLength(1))
    // 挂载函数挂完两条通道后才注册事件处理器：等 idle 出现再发事件，否则会被假任务丢掉
    await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.status).toBe('idle'))
    // 先只发 change（不动「已同步条数」），等它被 handler 收到再发 paused。
    // 这样 syncNow 内部 catchup 的基准值必定是 0：不会出现「事件先落地、基准后取值」的顺序竞争
    H.tasks[0]!.emitChange({ docs_written: 5, pending: 0 })
    await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.status).toBe('syncing'))
    H.tasks[0]!.emitPaused()
    const result = await pending
    expect(result.ok).toEqual([TIMELINE_ID])
    expect(result.added).toBe(5)
    expect(result.skipped).toBe(0)
    expect(result.serverPending).toBe(false)
  })

  it('服务端本轮没有新内容 → added=0、skipped=1（「已是最新」）', async () => {
    H.refresh = async () => ({ accepted: true, completed: true, added: 0 })
    const result = await pouch.syncNow()
    expect(result.added).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.serverPending).toBe(false)
    expect(result.failed).toHaveLength(0)
  })

  it('服务端超时（completed=false）→ serverPending=true，不算失败', async () => {
    H.refresh = async () => ({ accepted: true, completed: false })
    const result = await pouch.syncNow()
    expect(result.serverPending).toBe(true)
    expect(result.failed).toHaveLength(0)
    expect(result.added).toBe(0)
  })

  it('催促请求本身失败（离线）→ 如实报失败', async () => {
    H.refresh = async () => {
      throw new Error('offline')
    }
    const result = await pouch.syncNow()
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.id).toBe(TIMELINE_ID)
    expect(result.ok).toHaveLength(0)
  })
})
