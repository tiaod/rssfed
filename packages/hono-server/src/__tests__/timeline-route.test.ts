import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { aiSummaryEnabled: false },
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
  /** GET /events 的替身数据（真实实现在 services/timeline-events.ts，单测只验路由契约） */
  events: [
    { id: 2, at: new Date("2026-10-17T06:04:30.000Z"), kind: "reconcile", level: "info", message: "汇聚：订阅 129 个源，无需搬运（800ms）", data: { sources: 129 } },
    { id: 1, at: new Date("2026-10-16T22:00:00.000Z"), kind: "rebuild", level: "warn", message: "重建完成", data: null },
  ] as unknown[],
  sources: [
    { sourceId: "feed1", kind: "feed", title: "源一", syncedAt: new Date("2026-10-17T06:04:31.000Z"), status: "idle", lastError: null },
  ] as unknown[],
  /** 聚合心跳（GET /events 的第三段） */
  heartbeat: { at: new Date("2026-10-17T10:31:00.000Z"), quietRounds: 42 } as unknown,
  /** GET /events 收到的 limit 参数（验默认值/上限夹取） */
  eventLimits: [] as number[],
  clearedEvents: 0,
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
  // metaValues 是给 app.ts → bullboard.ts 的 BullMQAdapter 看的：它只认真实 Queue 实例，
  // 或 metaValues.version 以 "bullmq" 开头的鸭子类型（不跑看板，所以不需要真队列方法）
  timelineQueue: { getJob: async () => undefined, metaValues: { version: "bullmq@5" } },
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
  sourceSyncQueue: { getJob: async () => undefined, metaValues: { version: "bullmq@5" } },
  sourceSyncWorker: { close: async () => {} },
  shutdownSourceSyncWorker: async () => {},
}))

vi.mock("../services/timeline-events", () => ({
  listTimelineEvents: async (_userId: string, limit: number) => {
    state.eventLimits.push(limit)
    return state.events
  },
  listTimelineSources: async () => state.sources,
  readReconcileHeartbeat: async () => state.heartbeat,
  clearTimelineEvents: async () => {
    state.clearedEvents++
  },
}))

// 生命周期（活跃度上报 / 休眠恢复）不在单测范围内：替身保证路由中间件不碰 PG
vi.mock("../services/timeline-lifecycle", () => ({
  touchTimelineActivity: async () => {},
  resumeTimelineUser: async () => false,
  readTimelineUserState: async () => ({
    lastActiveAt: null,
    aggregationPausedAt: null,
    needsRebuild: false,
  }),
}))

vi.mock("../services/timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/timeline")>()
  return {
    ...actual,
    getTimelineSettings: async () => actual.normalizeTimelineSettings({ aiSummaryEnabled: false }),
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
    settings: { aiSummaryEnabled: false },
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
  state.eventLimits = []
  state.clearedEvents = 0
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
    expect((await patch({ aiSummaryEnabled: true })).status).toBe(401)
    expect((await app.request("/api/timeline/refresh", { method: "POST" })).status).toBe(401)
  })

  it("GET /settings 下发设置与默认值（没有 limits：保留策略已不在用户设置里）", async () => {
    const res = await app.request("/api/timeline/settings")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      settings: { aiSummaryEnabled: boolean }
      defaults: { aiSummaryEnabled: boolean }
      limits?: unknown
    }
    expect(body.settings).toEqual({ aiSummaryEnabled: false })
    expect(body.defaults).toEqual({ aiSummaryEnabled: false })
    expect(body).not.toHaveProperty("limits")
  })

  it("PATCH 非布尔 aiSummaryEnabled 返回 400 并说明", async () => {
    const res = await patch({ aiSummaryEnabled: "yes" })
    expect(res.status).toBe(400)
    const body = await res.json() as { details: string[] }
    expect(body.details).toHaveLength(1)
    expect(body.details[0]).toContain("aiSummaryEnabled")
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

  it("开 AI 摘要：写入设置并让聚合跑一轮（不重建）", async () => {
    state.settings = { settings: { aiSummaryEnabled: true } }
    const res = await patch({ aiSummaryEnabled: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ settings: { aiSummaryEnabled: true } })
    expect(state.reconcileQueued).toBe(1)
    expect(state.rebuildQueued).toBe(0)
  })

  it("未知字段不被当真：空补丁一律 400，不会入任何队", async () => {
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

describe("同步日志 /api/timeline/events", () => {
  it("返回流水与各源当前状态；limit 默认 120", async () => {
    const res = await app.request("/api/timeline/events")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      events: Array<{ message: string }>
      sources: Array<{ title: string }>
      heartbeat: { quietRounds: number } | null
    }
    expect(body.events).toHaveLength(2)
    expect(body.events[0]!.message).toContain("汇聚")
    expect(body.sources[0]!.title).toBe("源一")
    // 心跳是"聚合还在不在跑"的唯一展示口径（空转轮次不进流水）
    expect(body.heartbeat?.quietRounds).toBe(42)
    expect(state.eventLimits).toEqual([120])
  })

  it("limit 会被夹到 1..500（0、负数、超上限、非数字都退化成默认）", async () => {
    for (const [query, expected] of [
      ["?limit=300", 300],
      ["?limit=9999", 500],
      ["?limit=0", 120],
      ["?limit=-5", 120],
      ["?limit=abc", 120],
    ] as const) {
      await app.request(`/api/timeline/events${query}`)
      expect(state.eventLimits.at(-1)).toBe(expected)
    }
  })

  it("DELETE 清空该用户的流水", async () => {
    const res = await app.request("/api/timeline/events", { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.clearedEvents).toBe(1)
  })

  it("未登录一律 401（流水属于当前用户）", async () => {
    state.session = null
    expect((await app.request("/api/timeline/events")).status).toBe(401)
    expect((await app.request("/api/timeline/events", { method: "DELETE" })).status).toBe(401)
  })
})
