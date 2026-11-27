import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'
import {
  COMPACT_IDLE_DELAY_MS,
  IDLE_MAX_POSTPONE_MS,
  IDLE_QUIET_MS,
  INDEX_CATCHUP_MIN_INTERVAL_MS
} from '~/utils/localCompact'
import { markUserActivity, resetUserActivity } from '~/utils/userActivity'

/**
 * 「同步空闲后的本地库维护」什么时候动手。
 *
 * 这里验的是**时机**，不是门槛公式（门槛由 utils/localCompact 的单测覆盖）：
 *   1. 追平视图索引排在最前，且两个视图都要追（时间线 + 按源）；
 *   2. 用户还在操作就让位，但让位有上限 —— 不能让维护永远跑不上；
 *   3. 页面在后台时不必等（没人可打扰）；
 *   4. 追平失败不能连累裁剪 / 压缩。
 *
 * 为什么要追平：PouchDB 的 map view 是懒的，同步攒下的积压会在用户点「查看」那一刻现场
 * 补进索引（实测落后两千条时 880ms，热索引 7ms）。维护期追平就是把这段等待提前搬走。
 */

interface FakeTask {
  url: string
  direction: 'pull' | 'push'
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
}

const H = vi.hoisted(() => ({
  tasks: [] as FakeTask[],
  /** 每次 db.query 的视图名，按调用顺序 */
  queryViews: [] as string[],
  queryImpl: async (_view: string): Promise<{ rows: unknown[] }> => ({ rows: [] }),
  compactCalls: 0
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = {
      from: (url: string) => makeTask(url, 'pull'),
      to: (url: string) => makeTask(url, 'push')
    }

    compact = async () => {
      H.compactCalls++
      return { ok: true }
    }

    close = async () => {}
    destroy = async () => {}
    allDocs = async () => ({ rows: [] })
    query = async (view: string) => {
      H.queryViews.push(view)
      return H.queryImpl(view)
    }

    put = async () => ({ ok: true })
    bulkDocs = async () => []
  }
  function makeTask(url: string, direction: 'pull' | 'push') {
    const listeners = new Map<string, Set<(arg: unknown) => void>>()
    const task = {
      on: (event: string, fn: (arg: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(fn)
        return task
      },
      removeListener: () => task,
      cancel: () => {},
      then: () => task
    }
    const emit = (event: string, arg?: unknown) => listeners.get(event)?.forEach(fn => fn(arg))
    H.tasks.push({
      url,
      direction,
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
  localDbAccountKey: (uid: string | null) => uid ?? 'guest',
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
  lastTimelineTrimKey: (uid: string | null) => `rssfed-test-trimmed-${uid ?? 'guest'}`,
  lastTimelineIndexCatchupKey: (uid: string | null) => `rssfed-test-indexed-${uid ?? 'guest'}`,
  lastTimelineUrlKey: (uid: string | null) => `rssfed-test-url-${uid ?? 'guest'}`,
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
    timeline: { refresh: async () => ({ accepted: true, completed: true, added: 0 }) }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'idle-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

const INDEX_KEY = 'rssfed-test-indexed-idle-test'

function pullTask(): FakeTask {
  const task = H.tasks.filter(t => t.direction === 'pull').at(-1)
  if (!task) throw new Error('拉取通道尚未挂上')
  return task
}

/** 等 setTimeout 排上的异步维护跑完（fake timers 下推进时间后再冲一遍微任务） */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 推进到空闲维护该动手的时刻并等它跑完 */
async function runIdleMaintenance(extraMs = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS + extraMs)
  await flush()
}

let pouch: ReturnType<typeof usePouchDb>

beforeEach(async () => {
  H.tasks.length = 0
  H.queryViews.length = 0
  H.queryImpl = async () => ({ rows: [] })
  H.compactCalls = 0
  resetUserActivity()
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  vi.useFakeTimers()
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  await pouch.getUserDb()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetUserActivity()
})

describe('空闲维护：追平视图索引', () => {
  it('同步安静下来后把两个视图都追一遍，并记下时间', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await runIdleMaintenance()

    // 两个视图都要追：时间线走 timeline，单源 / 分组走 by_feed，
    // 只追一个的话另一个的积压还是留到用户点「查看」时才补
    expect(H.queryViews).toContain('local_entries_v1/timeline')
    expect(H.queryViews).toContain('local_entries_v1/by_feed')
    expect(Number(localStorage.getItem(INDEX_KEY))).toBeGreaterThan(0)
  })

  it('追平排在最前：先结掉「点查看要等的那一下」，再去做重的活', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await runIdleMaintenance()

    // 裁剪 / 压缩都会扫库，追平若排在它们后面，最该早做的事就得等最重的活干完
    expect(H.queryViews[0]).toBe('local_entries_v1/timeline')
  })

  it('十分钟内不重复追（索引热的时候追一次就够了）', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await runIdleMaintenance()
    const afterFirst = H.queryViews.length
    expect(afterFirst).toBeGreaterThan(0)

    pullTask().emitPaused()
    await runIdleMaintenance()

    // 第二轮只剩裁剪自己的源清单查询（一条 by_feed），没有新的追平查询
    expect(H.queryViews.length - afterFirst).toBeLessThanOrEqual(1)
  })

  it('超过十分钟后下一轮空闲再追一次', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await runIdleMaintenance()
    const afterFirst = H.queryViews.length

    vi.setSystemTime(Date.now() + INDEX_CATCHUP_MIN_INTERVAL_MS + 1000)
    pullTask().emitPaused()
    await runIdleMaintenance()

    expect(H.queryViews.length - afterFirst).toBeGreaterThanOrEqual(2)
  })

  it('用户暂停了同步：不追（维护整体停摆）', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    pouch.pauseSync()
    await runIdleMaintenance()

    expect(H.queryViews).toHaveLength(0)
  })

  it('追平失败不连累裁剪与压缩：各自兜各自的错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    H.queryImpl = async (view) => {
      if (view === 'local_entries_v1/timeline') throw new Error('索引库坏了')
      return { rows: [] }
    }

    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await runIdleMaintenance()

    expect(warn).toHaveBeenCalled()
    // 追平失败没有记时间戳（下次空闲还能再试），但压缩照常发生
    expect(localStorage.getItem(INDEX_KEY)).toBeNull()
    expect(H.compactCalls).toBe(1)
  })
})

describe('空闲维护：与用户操作错开', () => {
  it('用户刚动过手就让位，等安静下来再动手', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()

    // 到点前一刻用户还在翻列表：这一刻维护撞上他，正是「点查看卡两秒」的成因
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS - 5_000)
    markUserActivity()
    await vi.advanceTimersByTimeAsync(5_010)
    await flush()

    expect(H.queryViews).toHaveLength(0)
    expect(H.compactCalls).toBe(0)

    // 停手够久之后补上
    await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS)
    await flush()

    expect(H.queryViews.length).toBeGreaterThan(0)
    expect(H.compactCalls).toBe(1)
  })

  it('用户一直在操作也不会永远等：到上限照常维护', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()

    // 每两秒动一下手、一直不停：让位必须有尽头，否则索引永远追不平，下一次点「查看」
    // 还是卡那几秒 —— 那正是这套机制要解决的问题本身
    const stepMs = 2_000
    const capMs = IDLE_MAX_POSTPONE_MS + 60_000
    let elapsed = 0
    while (H.queryViews.length === 0 && elapsed < capMs) {
      markUserActivity()
      await vi.advanceTimersByTimeAsync(stepMs)
      await flush()
      elapsed += stepMs
    }

    expect(H.queryViews.length).toBeGreaterThan(0)
    // 而且确实是等到上限才动手的，不是一开始就硬闯
    expect(elapsed).toBeGreaterThan(IDLE_MAX_POSTPONE_MS)
  })

  it('页面在后台：不必等用户停手', async () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await pouch.ensureTimelineLiveSync()
      pullTask().emitPaused()
      await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS - 1_000)
      markUserActivity()
      await runIdleMaintenance(1_010)

      expect(H.queryViews.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('让位期间被取消（暂停同步）：定时器与「到期起点」都清干净', async () => {
    await pouch.ensureTimelineLiveSync()
    pullTask().emitPaused()
    await vi.advanceTimersByTimeAsync(COMPACT_IDLE_DELAY_MS - 5_000)
    markUserActivity()
    pouch.pauseSync()
    await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS + 10_000)
    await flush()

    expect(H.queryViews).toHaveLength(0)
  })
})
