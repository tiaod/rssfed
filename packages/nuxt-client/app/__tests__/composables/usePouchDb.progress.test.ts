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
  emitChange: (info: {
    /** 本批写入成功的文档（PouchDB 复制 change 事件真实会带的字段）：按源记账靠它 */
    docs?: Array<{ type?: string, feedId?: string }>
    docs_written?: number
    pending?: number
  }) => void
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
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
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

/** 一条复制写入的文档（只写断言关心的字段） */
const doc = (type: string, feedId?: string) => ({ type, feedId })

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

  /**
   * 剩余时间估算：只用「本轮」的写入速率 × 服务端剩余条数。
   *
   * 累计写入数（docs_written）是复制实例级的，跨轮不可比 —— 上一轮跑了几千条之后，
   * 这一轮第一批就会把它抬高，拿它算速率会得到假速度。所以每轮都要重新取基准。
   */
  it('剩余时间按本轮实测速率折算；样本不足时不显示', async () => {
    await startLive()
    const T0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      // 第一批：建立本轮基准，但窗口不足 3 秒 → 算不出来
      H.tasks[0]!.emitChange({ docs_written: 10, pending: 90 })
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBeUndefined()

      // 10 秒写入 20 条 → 2 条/秒，剩 65 条 → 约 32.5 秒
      nowSpy.mockReturnValue(T0 + 10_000)
      H.tasks[0]!.emitChange({ docs_written: 30, pending: 65 })
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBe(32_500)

      // pending 到 0 = 已拉完：ETA 不再有意义，清掉而不是显示「不到 10 秒」
      nowSpy.mockReturnValue(T0 + 20_000)
      H.tasks[0]!.emitChange({ docs_written: 95, pending: 0 })
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('暂停后的新一轮重新取速率基准，不继承上一轮的累计写入数', async () => {
    await startLive()
    const T0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      // 第一轮：10 秒写 20 条，然后收尾
      H.tasks[0]!.emitChange({ docs_written: 10, pending: 100 })
      nowSpy.mockReturnValue(T0 + 10_000)
      H.tasks[0]!.emitChange({ docs_written: 30, pending: 90 })
      H.tasks[0]!.emitPaused()
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBeUndefined()

      // 第二轮：服务端又推了 40 条。本轮 10 秒写 10 条 → 1 条/秒，剩 25 条 → 25 秒。
      // 若沿用上一轮基准（10 条 / T0），会算成 (50-10)/20s = 2 条/秒 → 12.5 秒
      nowSpy.mockReturnValue(T0 + 20_000)
      H.tasks[0]!.emitChange({ docs_written: 40, pending: 25 })
      nowSpy.mockReturnValue(T0 + 30_000)
      H.tasks[0]!.emitChange({ docs_written: 50, pending: 25 })
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBe(25_000)
    } finally {
      nowSpy.mockRestore()
    }
  })

  /**
   * 手动同步也会把状态写成 syncing（用户点按钮那一刻），但那是**新一轮**：
   * 上一轮的速率基准必须作废，否则拿「上一轮的累计写入数 / 这一轮的时间」会算出假速度。
   * 基准放在状态对象里而不是复制闭包里，正是为了识别这类「状态被外部重建」的边界。
   */
  it('手动同步开始的新一轮重置速率基准', async () => {
    await startLive()
    const T0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      // 上一轮已经累计写入 1010 条（live 复制实例的累计值），然后安静下来
      H.tasks[0]!.emitChange({ docs_written: 1000, pending: 100 })
      nowSpy.mockReturnValue(T0 + 10_000)
      H.tasks[0]!.emitChange({ docs_written: 1010, pending: 90 })
      H.tasks[0]!.emitPaused()

      // 手动同步：先把 refresh 挂住，好在「同步中」的状态里注入新一批 change
      let release!: (value: { accepted: boolean, completed?: boolean, added?: number }) => void
      H.refresh = () => new Promise((resolve) => {
        release = resolve
      })
      const pending = pouch.syncNow()
      await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.status).toBe('syncing'))
      await vi.waitFor(() => expect(H.tasks[0]!.listenerCount('change')).toBeGreaterThan(0))

      nowSpy.mockReturnValue(T0 + 20_000)
      H.tasks[0]!.emitChange({ docs_written: 1020, pending: 25 })
      nowSpy.mockReturnValue(T0 + 30_000)
      H.tasks[0]!.emitChange({ docs_written: 1060, pending: 25 })
      // 本轮 10 秒写 40 条 → 4 条/秒，剩 25 条 → 6.25 秒；
      // 若沿用上一轮基准（1000 条 / T0），会算成 30 秒 60 条 = 2 条/秒 → 12.5 秒
      expect(pouch.syncStatuses[TIMELINE_ID]!.etaMs).toBe(6250)

      release({ accepted: true, completed: true, added: 0 })
      await pending
    } finally {
      nowSpy.mockRestore()
    }
  })
})

/**
 * 「已同步 N 条」的记账口径：全库一个数字回答不了「当前这个列表多了几条」——
 * 在单源页点一次全局同步，别的源的新条目会一起算进去。所以按 entry 文档自带的 feedId 分摊，
 * 页面再按自己的源求和（`syncedEntryCount`）。
 */
describe('按源分摊的条目记账', () => {
  it('只算 entry 文档，并按 feedId 分到各源', async () => {
    await startLive()
    H.tasks[0]!.emitChange({
      docs: [
        doc('entry', 'feed-a'),
        doc('entry', 'feed-a'),
        doc('entry', 'feed-b'),
        // 同一个批次里还有源文档（不是条目）与用户状态文档：都不该计入
        doc('feed', 'feed-a'),
        doc('entry-state')
      ],
      docs_written: 5,
      pending: 0
    })

    expect(pouch.syncedEntryCount()).toBe(3)
    expect(pouch.syncedEntryCount(['feed-a'])).toBe(2)
    expect(pouch.syncedEntryCount(['feed-b'])).toBe(1)
    expect(pouch.syncedEntryCount(['feed-a', 'feed-b'])).toBe(3)
    // 本列表一条都没多：单源页的提示条不该因为别的源有更新而涨
    expect(pouch.syncedEntryCount(['feed-c'])).toBe(0)
  })

  it('没有 feedId 的 entry 文档不计入任何源（只进不了分摊表，不影响同步本身）', async () => {
    await startLive()
    H.tasks[0]!.emitChange({ docs: [doc('entry')], docs_written: 1, pending: 0 })
    expect(pouch.syncedEntryCount()).toBe(0)
  })
})

describe('syncNow 的新增条数', () => {
  it('syncNow 把本轮真正落到本地的条目按源拆出来（服务端只说总数，分不出源）', async () => {
    let release!: (value: { accepted: boolean, completed?: boolean, added?: number }) => void
    H.refresh = () => new Promise((resolve) => {
      release = resolve
    })
    const pending = pouch.syncNow()
    await vi.waitFor(() => expect(H.tasks).toHaveLength(1))
    await vi.waitFor(() => expect(H.tasks[0]!.listenerCount('change')).toBeGreaterThan(0))

    // 服务端还没回应，内容先落到了本地
    H.tasks[0]!.emitChange({
      docs: [doc('entry', 'feed-a'), doc('entry', 'feed-b'), doc('entry', 'feed-b')],
      docs_written: 3,
      pending: 0
    })
    release({ accepted: true, completed: true, added: 0 })

    const result = await pending
    expect(result.addedByFeed).toEqual({ 'feed-a': 1, 'feed-b': 2 })
  })

  it('服务端报新增 N 条：等 live 复制把 N 条落地后 added=N', async () => {
    H.refresh = async () => ({ accepted: true, completed: true, added: 5 })
    const pending = pouch.syncNow()
    // 等 live 复制挂上（resumeSync 会先挂，syncNow 再等它）。
    await vi.waitFor(() => expect(H.tasks).toHaveLength(1))
    // 处理器是在挂载末尾注册的，注册前发事件会被假任务丢掉。不能再用「状态落到 idle」当这个
    // 信号：手动同步一开始就把状态置成 syncing 了（见 usePouchDb 的 beginManualSync），
    // 所以直接等监听器挂上
    await vi.waitFor(() => expect(H.tasks[0]!.listenerCount('change')).toBeGreaterThan(0))
    // 先只发 change（不动「已同步条数」），等它被 handler 收到再发 paused。
    // 这样 syncNow 内部 catchup 的基准值必定是 0：不会出现「事件先落地、基准后取值」的顺序竞争
    H.tasks[0]!.emitChange({ docs_written: 5, pending: 0 })
    await vi.waitFor(() => expect(pouch.syncStatuses[TIMELINE_ID]?.docsWritten).toBe(5))
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

  /**
   * 手动同步的状态反馈：常驻 live 复制在「客户端已跟上服务端」时一个事件都不发，只等服务端
   * 的那几秒里状态必须自己亮起来 —— 否则点按钮看着像没反应（旧实现逐源入队时有 queued/syncing，
   * 单库改造后这条迁移丢了）。
   */
  it('一发起就报「同步中」、不带上一轮的进度；空转收尾回 idle', async () => {
    let release!: (value: { accepted: boolean, completed?: boolean, added?: number }) => void
    H.refresh = () => new Promise((resolve) => {
      release = resolve
    })
    const pending = pouch.syncNow()

    // 还没等服务端返回（也没等 live 复制挂上）就该是 syncing
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('syncing')
    // 上一轮的百分比/条数不能带进来：否则弹层会显示一个不动的「已同步 80%」
    expect(pouch.syncStatuses[TIMELINE_ID]!.progress).toBeUndefined()
    expect(pouch.syncStatuses[TIMELINE_ID]!.docsWritten).toBeUndefined()

    release({ accepted: true, completed: true, added: 0 })
    await pending

    // 空转（服务端 0 条、live 复制没写任何东西）也要收干净，不能一直转
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('idle')
    expect(pouch.syncStatuses[TIMELINE_ID]!.lastSyncedAt).toBeTruthy()
  })

  it('服务端超时（completed=false）→ serverPending=true，不算失败', async () => {
    H.refresh = async () => ({ accepted: true, completed: false })
    const result = await pouch.syncNow()
    expect(result.serverPending).toBe(true)
    expect(result.failed).toHaveLength(0)
    expect(result.added).toBe(0)
  })

  it('催促请求本身失败（离线）→ 如实报失败，指示器落到 error 而不是悄悄回 idle', async () => {
    H.refresh = async () => {
      throw new Error('offline')
    }
    const result = await pouch.syncNow()
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.id).toBe(TIMELINE_ID)
    expect(result.ok).toHaveLength(0)
    expect(pouch.syncStatuses[TIMELINE_ID]!.status).toBe('error')
    expect(pouch.syncStatuses[TIMELINE_ID]!.error).toContain('无法联系服务端')
  })
})
