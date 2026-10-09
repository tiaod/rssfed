import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 「优先同步当前列表」（`syncPriority`）：进入列表时催一次服务端聚合，并等新内容落库。
 *
 * 语义已经比旧版简单得多 —— 所有源都在同一个时间线库里，服务端一次聚合全带上，
 * 因此「优先同步哪些源」这件事不存在了。这里锁定四条：
 *   1. 只催一次（且是即发即忘的催促，不是 wait=1 的同步请求：首屏不能被 HTTP 请求挂住）；
 *   2. 新内容在预算内落库 → done=true，并报出新增条数；
 *   3. 超时 → done=false，但**不取消** live 复制（数据随后自己到端）；
 *   4. 用户已暂停 → 什么都不做（暂停是显式动作，进列表不该偷偷恢复）。
 */

interface FakeTask {
  url: string
  emitChange: (info: { docs_written?: number, pending?: number }) => void
  emitPaused: () => void
}

const H = vi.hoisted(() => ({
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
    remoteUrlForId: async (id: string) => (id === '__timeline__' ? 'http://remote.test/timeline' : null),
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
  useUserStore: () => ({ user: { id: 'priority-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

let pouch: ReturnType<typeof usePouchDb>

beforeEach(() => {
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

describe('优先同步（进入列表时催一次并等结果）', () => {
  it('催促一次（不带 wait），新内容落库后 done=true 并报出条数', async () => {
    const pending = pouch.syncPriority(1000)
    // refresh 是即发即忘的催促：参数为 undefined（不是 { wait: 1 }）
    await vi.waitFor(() => expect(H.refreshArgs).toHaveLength(1))
    expect(H.refreshArgs[0]).toEqual([undefined])
    await vi.waitFor(() => expect(H.tasks).toHaveLength(1))

    H.tasks[0]!.emitChange({ docs_written: 4, pending: 0 })
    H.tasks[0]!.emitPaused()

    const result = await pending
    expect(result.done).toBe(true)
    expect(result.added).toBe(4)
    expect(result.skipped).toBe(0)
  })

  it('超时不再等（done=false），但复制没有被取消', async () => {
    const result = await pouch.syncPriority(50)
    expect(result.done).toBe(false)
    expect(result.added).toBe(0)
    // 句柄还在：数据随后自己到端
    expect(H.tasks).toHaveLength(1)
  })

  it('用户已暂停时不动：不催、不挂复制', async () => {
    pouch.pauseSync()
    const result = await pouch.syncPriority(1000)
    expect(result.done).toBe(true)
    expect(result.added).toBe(0)
    expect(H.refreshArgs).toHaveLength(0)
    expect(H.tasks).toHaveLength(0)
  })

  it('催促请求失败（离线）→ skipped=1，仍照常等本地是否有内容', async () => {
    H.refresh = async () => {
      throw new Error('offline')
    }
    const result = await pouch.syncPriority(50)
    expect(result.skipped).toBe(1)
    expect(result.added).toBe(0)
  })
})
