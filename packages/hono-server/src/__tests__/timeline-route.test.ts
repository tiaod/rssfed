import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { windowDays: 3, aiSummaryEnabled: false },
  },
  reconcileQueued: 0,
  rebuildQueued: 0,
  /** wait=1 时拓扑对齐（reconcile）返回的订阅源数 */
  inlineSources: 12,
  /** wait=1 时「等复制器送到」的结果；completed=false 模拟超时 */
  inlineSync: { completed: true, added: 7 } as { completed: boolean, added: number },
  inlineCalls: 0,
  syncCalls: 0,
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

// 队列与 PG 都不在单测范围内：这里只验证路由的参数校验与「该入哪个队」的分支
vi.mock("../workers/timeline", () => ({
  enqueueTimelineReconcile: async () => {
    state.reconcileQueued++
  },
  enqueueTimelineRebuild: async () => {
    state.rebuildQueued++
  },
  timelineQueue: { getJob: async () => undefined },
  timelineWorker: { close: async () => {} },
  notifyTimelineStale: async () => {},
  shutdownTimelineWorkers: async () => {},
}))

vi.mock("../services/timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/timeline")>()
  return {
    ...actual,
    getTimelineSettings: async () => actual.normalizeTimelineSettings({ windowDays: 3 }),
    updateTimelineSettings: async () => state.settings,
    // wait=1 的刷新分两步：先在本请求内对齐复制拓扑，再轮询派生库等复制器送到。
    // 两个替身都不碰 CouchDB，覆盖「追平」与「超时」两条分支。
    reconcileUserTimeline: async () => {
      state.inlineCalls++
      return { sources: state.inlineSources }
    },
    waitForSync: async () => {
      state.syncCalls++
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
  state.rebuildQueued = 0
  state.inlineSources = 12
  state.inlineSync = { completed: true, added: 7 }
  state.inlineCalls = 0
  state.syncCalls = 0
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

  it("POST /refresh?wait=1：本请求内对齐拓扑并等复制器送到，带上确切条数", async () => {
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: true, added: 7, sources: 12 })
    // 直连处理了，就不该再入队（同一份工作不该跑两遍）
    expect(state.reconcileQueued).toBe(0)
    expect(state.inlineCalls).toBe(1)
    expect(state.syncCalls).toBe(1)
  })

  it("POST /refresh?wait=1 超时：200 报 completed=false（复制仍在后台跑，不入队重跑）", async () => {
    state.inlineSync = { completed: false, added: 2 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: false, added: 2, sources: 12 })
    expect(state.reconcileQueued).toBe(0)
  })
})
