import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { aiSummaryEnabled: false },
  },
  /** 入队抓取时带的选项（bypassCache = 强制真正发请求） */
  enqueueOptions: [] as Array<Record<string, unknown>>,
  enqueueCalls: 0,
  /** 入队时报告"有几个源入队了" */
  enqueueCount: 12,
  /** wait=1 时「等库安静下来」的替身结果；completed=false 模拟超时 */
  inlineSync: { completed: true, added: 7 } as { completed: boolean, added: number },
  syncCalls: 0,
  syncOptions: null as Record<string, unknown> | null,
  /** 休眠恢复是否触发 */
  resumed: false,
  /** GET /events 的替身数据（真实实现在 services/timeline-events.ts，单测只验路由契约） */
  events: [
    { id: 2, at: new Date("2026-10-17T06:04:30.000Z"), kind: "reconcile", level: "info", message: "抓取：订阅 129 个源，无需抓取（800ms）", data: { sources: 129 } },
    { id: 1, at: new Date("2026-10-16T22:00:00.000Z"), kind: "rebuild", level: "warn", message: "重建完成", data: null },
  ] as unknown[],
  /** 抓取心跳（GET /events 的第二段） */
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
vi.mock("../workers", () => ({
  enqueueOwnerSubscriptions: async (_owner: unknown, options: Record<string, unknown> = {}) => {
    state.enqueueCalls++
    state.enqueueOptions.push(options)
    return state.enqueueCount
  },
  // metaValues 是给 app.ts → bullboard.ts 的 BullMQAdapter 看的：它只认真实 Queue 实例，
  // 或 metaValues.version 以 "bullmq" 开头的鸭子类型（不跑看板，所以不需要真队列方法）
  fetchQueue: { getJob: async () => undefined, metaValues: { version: "bullmq@5" } },
  worker: { close: async () => {} },
  enqueueOwnerFetch: async () => {},
  shutdownFetchWorker: async () => {},
}))

vi.mock("../services/timeline-events", () => ({
  listTimelineEvents: async (_userId: string, limit: number) => {
    state.eventLimits.push(limit)
    return state.events
  },
  readReconcileHeartbeat: async () => state.heartbeat,
  clearTimelineEvents: async () => {
    state.clearedEvents++
  },
}))

// 生命周期（活跃度上报 / 休眠恢复）不在单测范围内：替身保证路由中间件不碰 PG
vi.mock("../services/timeline-lifecycle", () => ({
  touchTimelineActivity: async () => {},
}))

vi.mock("../services/owner-platform", () => ({
  resumeOwner: async () => state.resumed,
}))

vi.mock("../services/timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/timeline")>()
  return {
    ...actual,
    getTimelineSettings: async () => actual.normalizeTimelineSettings({ aiSummaryEnabled: false }),
    updateTimelineSettings: async () => state.settings,
    // wait=1 的刷新分两步：取起始序号 → 入队全部订阅 → 等库安静下来再数条数。
    readTimelineUpdateSeq: async () => 41,
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
  state.enqueueOptions = []
  state.enqueueCalls = 0
  state.enqueueCount = 12
  state.inlineSync = { completed: true, added: 7 }
  state.syncCalls = 0
  state.syncOptions = null
  state.resumed = false
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
    expect(state.enqueueCalls).toBe(0)
  })

  it("空补丁返回 400", async () => {
    expect((await patch({})).status).toBe(400)
    expect((await patch({ nope: 1 })).status).toBe(400)
  })

  it("非 JSON 请求体返回 400", async () => {
    const res = await app.request("/api/timeline/settings", { method: "PATCH", body: "not json" })
    expect(res.status).toBe(400)
  })

  it("开 AI 摘要：写入设置（新模型下不触发抓取 —— 设置不影响抓什么）", async () => {
    state.settings = { settings: { aiSummaryEnabled: true } }
    const res = await patch({ aiSummaryEnabled: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ settings: { aiSummaryEnabled: true } })
    expect(state.enqueueCalls).toBe(0)
  })

  it("未知字段不被当真：空补丁一律 400，不会入任何队", async () => {
    const res = await patch({ maxImageCount: 2 })
    expect(res.status).toBe(400)
    expect(state.enqueueCalls).toBe(0)
  })

  it("POST /refresh 与 /rebuild 返回 202，并把该用户的全部订阅入队", async () => {
    expect((await app.request("/api/timeline/refresh", { method: "POST" })).status).toBe(202)
    expect(state.enqueueCalls).toBe(1)
    // 默认走缓存：调度产生的抓取不该每次都真的打外网
    expect(state.enqueueOptions).toEqual([{ bypassCache: false }])

    expect((await app.request("/api/timeline/rebuild", { method: "POST" })).status).toBe(202)
    expect(state.enqueueCalls).toBe(2)
    // 「重新同步」按钮要真的重抓：绕开抓取缓存
    expect(state.enqueueOptions.at(-1)).toEqual({ bypassCache: true })
  })

  it("POST /refresh?wait=1：入队全部订阅、等库安静下来再数条数", async () => {
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      accepted: true,
      completed: true,
      added: 7,
      queued: 12,
    })
    expect(state.enqueueCalls).toBe(1)
    expect(state.syncCalls).toBe(1)
    // 起始序号必须在入队前取好传进来，否则条目已写完、会数成 0
    expect(state.syncOptions).toMatchObject({ sinceSeq: 41, minWaitMs: 0 })
  })

  it("POST /refresh?wait=1 没等到安静：200 报 completed=false（抓取仍在后台跑）", async () => {
    state.inlineSync = { completed: false, added: 2 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: false, added: 2 })
  })

  it("force=1 绕开抓取缓存（运维逃生口：默认路径命中缓存不发请求）", async () => {
    const waited = await app.request("/api/timeline/refresh?wait=1&force=1", { method: "POST" })
    expect(waited.status).toBe(200)
    expect(state.enqueueOptions).toEqual([{ bypassCache: true }])

    const queued = await app.request("/api/timeline/refresh?force=1", { method: "POST" })
    expect(queued.status).toBe(202)
    expect(state.enqueueOptions.at(-1)).toEqual({ bypassCache: true })
  })

  it("不带 force 时不绕缓存（默认路径必须能复用抓取结果）", async () => {
    await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    await app.request("/api/timeline/refresh", { method: "POST" })
    expect(state.enqueueOptions).toEqual([{ bypassCache: false }, { bypassCache: false }])
  })

  it("没有订阅时也能正常返回（queued=0，不阻塞）", async () => {
    state.enqueueCount = 0
    state.inlineSync = { completed: true, added: 0 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: true, added: 0, queued: 0 })
  })

  it("休眠用户回来时清掉休眠标记（新模型下不需要重建）", async () => {
    state.resumed = true
    const res = await app.request("/api/timeline/settings")
    expect(res.status).toBe(200)
    // 恢复本身不进响应：它是中间件的副作用，这里只确认请求没被它打断
    expect(await res.json()).toMatchObject({ settings: { aiSummaryEnabled: false } })
  })
})

describe("同步日志 /api/timeline/events", () => {
  it("返回流水与心跳；limit 默认 120", async () => {
    const res = await app.request("/api/timeline/events")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      events: Array<{ message: string }>
      heartbeat: { quietRounds: number } | null
      sources?: unknown
    }
    expect(body.events).toHaveLength(2)
    expect(body.events[0]!.message).toContain("抓取")
    // 心跳是"抓取还在不在跑"的唯一展示口径（空转轮次不进流水）
    expect(body.heartbeat?.quietRounds).toBe(42)
    // `sources`（每源同步水位）已随水位表一起删掉：现在每个源的抓取状态在 `_local/schedule` 里，
    // 客户端要展示的话走订阅列表接口，不再由这里下发
    expect(body).not.toHaveProperty("sources")
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
