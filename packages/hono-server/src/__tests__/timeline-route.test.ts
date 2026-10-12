import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { windowDays: 3, aiSummaryEnabled: false },
  },
  reconcileQueued: 0,
  /** 入队 reconcile 时带的选项（force 逃生口） */
  reconcileQueuedOptions: [] as Array<Record<string, unknown>>,
  /** wait=1 直连 reconcile 时带的选项 */
  reconcileOptions: [] as Array<Record<string, unknown>>,
  rebuildQueued: 0,
  /** wait=1 时拓扑对齐（reconcile）返回的订阅源数与其判定出来的脏源 */
  inlineSources: 12,
  inlineDirty: ["feed1"] as string[],
  /** wait=1 时「等复制器送到」的结果；completed=false 模拟超时 */
  inlineSync: { completed: true, added: 7 } as { completed: boolean, added: number },
  /** wait=1 时入队/等待的替身记录 */
  inlineCalls: 0,
  syncCalls: 0,
  syncOptions: null as Record<string, unknown> | null,
  enqueued: [] as Array<{ userId: string, sourceIds: string[] }>,
  drained: true,
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

// 队列与 PG 都不在单测范围内：这里只验证路由的参数校验与「该入哪个队」的分支
vi.mock("../workers/timeline", () => ({
  enqueueTimelineReconcile: async (_userId: string, options: Record<string, unknown> = {}) => {
    state.reconcileQueued++
    state.reconcileQueuedOptions.push(options)
  },
  enqueueTimelineRebuild: async () => {
    state.rebuildQueued++
  },
  timelineQueue: { getJob: async () => undefined },
  timelineWorker: { close: async () => {} },
  notifyTimelineStale: async () => {},
  shutdownTimelineWorkers: async () => {},
}))

// 单源同步队列同样不进单测：这里只记「脏源有没有被交给队列」
vi.mock("../workers/timeline-sync", () => ({
  enqueueSourceSyncs: async (userId: string, sourceIds: string[]) => {
    state.enqueued.push({ userId, sourceIds })
    return sourceIds.map(sourceId => ({ id: sourceId }))
  },
  waitForSourceSyncs: async () => state.drained,
  sourceSyncQueue: { getJob: async () => undefined },
  sourceSyncWorker: { close: async () => {} },
  shutdownSourceSyncWorker: async () => {},
}))

vi.mock("../services/timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/timeline")>()
  return {
    ...actual,
    getTimelineSettings: async () => actual.normalizeTimelineSettings({ windowDays: 3 }),
    updateTimelineSettings: async () => state.settings,
    // wait=1 的刷新分三步：取起始序号 → 本请求内对齐拓扑并把这批脏源交给同步队列 → 等它们跑完再数条数。
    // 三个替身都不碰 CouchDB/Redis，覆盖「追平」与「超时」两条分支。
    readTimelineUpdateSeq: async () => 41,
    reconcileUserTimeline: async (_userId: string, options: Record<string, unknown> = {}) => {
      state.inlineCalls++
      state.reconcileOptions.push(options)
      return { sources: state.inlineSources, dirtySources: state.inlineDirty }
    },
    waitForSync: async (_userId: string, _timeoutMs: number, options: Record<string, unknown>) => {
      state.syncCalls++
      state.syncOptions = options
      return state.inlineSync
    },
  }
})

const { app } = await import("../app")

beforeEach(() => {
  state.session = { user: { id: "u1" } }
  state.settings = {
    settings: { windowDays: 3, aiSummaryEnabled: false },
  }
  state.reconcileQueued = 0
  state.reconcileQueuedOptions = []
  state.reconcileOptions = []
  state.rebuildQueued = 0
  state.inlineSources = 12
  state.inlineDirty = ["feed1"]
  state.inlineSync = { completed: true, added: 7 }
  state.inlineCalls = 0
  state.syncCalls = 0
  state.syncOptions = null
  state.enqueued = []
  state.drained = true
})

async function patch(body: unknown) {
  return app.request("/api/timeline/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("/api/timeline", () => {
  it("未登录一律 401", async () => {
    state.session = null
    expect((await app.request("/api/timeline/settings")).status).toBe(401)
    expect((await patch({ windowDays: 7 })).status).toBe(401)
    expect((await app.request("/api/timeline/refresh", { method: "POST" })).status).toBe(401)
  })

  it("GET /settings 下发设置、默认值与合法区间", async () => {
    const res = await app.request("/api/timeline/settings")
    expect(res.status).toBe(200)
    const body = await res.json() as { settings: { windowDays: number }, defaults: { windowDays: number }, limits: { windowDays: { min: number } } }
    expect(body.settings.windowDays).toBe(3)
    expect(body.defaults.windowDays).toBe(3)
    expect(body.limits.windowDays.min).toBe(0)
  })

  it("PATCH 越界值返回 400 并逐项说明", async () => {
    const res = await patch({ windowDays: 1000, aiSummaryEnabled: "yes" })
    expect(res.status).toBe(400)
    const body = await res.json() as { details: string[] }
    expect(body.details).toHaveLength(2)
    expect(state.reconcileQueued + state.rebuildQueued).toBe(0)
  })

  it("空补丁返回 400", async () => {
    expect((await patch({})).status).toBe(400)
    expect((await patch({ nope: 1 })).status).toBe(400)
  })

  it("非 JSON 请求体返回 400", async () => {
    const res = await app.request("/api/timeline/settings", { method: "PATCH", body: "not json" })
    expect(res.status).toBe(400)
  })

  it("改窗口：入队一次增量聚合（窗口边界由 reconcile 自己回填/剪枝，不重建）", async () => {
    state.settings = { settings: { windowDays: 7, aiSummaryEnabled: false } }
    const res = await patch({ windowDays: 7 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ settings: { windowDays: 7 } })
    expect(state.reconcileQueued).toBe(1)
    expect(state.rebuildQueued).toBe(0)
  })

  it("图片参数不再是用户设置：整包 PATCH 一律 400，不会入任何队", async () => {
    const res = await patch({ maxImageCount: 2 })
    expect(res.status).toBe(400)
    expect(state.reconcileQueued).toBe(0)
    expect(state.rebuildQueued).toBe(0)
  })

  it("POST /refresh 与 /rebuild 返回 202", async () => {
    expect((await app.request("/api/timeline/refresh", { method: "POST" })).status).toBe(202)
    expect((await app.request("/api/timeline/rebuild", { method: "POST" })).status).toBe(202)
    expect(state.reconcileQueued).toBe(1)
    expect(state.rebuildQueued).toBe(1)
  })

  it("POST /refresh?wait=1：本请求内对齐拓扑、把脏源交给同步队列、等它们跑完再数条数", async () => {
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      accepted: true,
      completed: true,
      added: 7,
      sources: 12,
      queued: 1,
    })
    // 直连处理了，就不该再入队（同一份工作不该跑两遍）
    expect(state.reconcileQueued).toBe(0)
    expect(state.inlineCalls).toBe(1)
    expect(state.enqueued).toEqual([{ userId: "u1", sourceIds: ["feed1"] }])
    expect(state.syncCalls).toBe(1)
    // 起始序号必须在入队前取好传进来，否则条目已写完、会数成 0
    expect(state.syncOptions).toMatchObject({ sinceSeq: 41, quietRounds: 1, minWaitMs: 0 })
  })

  it("POST /refresh?wait=1 没等到队排空：200 报 completed=false（同步仍在后台跑，不入队重跑）", async () => {
    state.drained = false
    state.inlineSync = { completed: false, added: 2 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: false, added: 2, sources: 12 })
    expect(state.reconcileQueued).toBe(0)
  })

  it("force=1 跳过水位判定：wait=1 直连带上 force，非 wait 入队也带上", async () => {
    const waited = await app.request("/api/timeline/refresh?wait=1&force=1", { method: "POST" })
    expect(waited.status).toBe(200)
    expect(state.reconcileOptions).toEqual([{ force: true }])

    const queued = await app.request("/api/timeline/refresh?force=1", { method: "POST" })
    expect(queued.status).toBe(202)
    expect(state.reconcileQueuedOptions).toEqual([{ force: true }])
  })

  it("不带 force 时不会误开逃生口（默认路径必须走水位判定）", async () => {
    await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    await app.request("/api/timeline/refresh", { method: "POST" })
    expect(state.reconcileOptions).toEqual([{ force: false }])
    expect(state.reconcileQueuedOptions).toEqual([{ force: false }])
  })

  it("POST /refresh?wait=1 且没有脏源：不入任何同步 job，也不阻塞", async () => {
    state.inlineDirty = []
    state.inlineSync = { completed: true, added: 0 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: true, added: 0, queued: 0 })
    expect(state.enqueued).toEqual([{ userId: "u1", sourceIds: [] }])
  })
})
