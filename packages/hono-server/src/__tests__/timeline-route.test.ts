import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { windowDays: 3, maxImageCount: 6, aiSummaryEnabled: false },
    needsRebuild: false,
  },
  reconcileQueued: 0,
  rebuildQueued: 0,
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
  }
})

const { app } = await import("../app")

beforeEach(() => {
  state.session = { user: { id: "u1" } }
  state.settings = {
    settings: { windowDays: 3, maxImageCount: 6, aiSummaryEnabled: false },
    needsRebuild: false,
  }
  state.reconcileQueued = 0
  state.rebuildQueued = 0
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
    const res = await patch({ windowDays: 1000, avifQuality: 999 })
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

  it("只改窗口：入队增量聚合，不重建", async () => {
    state.settings = { settings: { windowDays: 7, maxImageCount: 6, aiSummaryEnabled: false }, needsRebuild: false }
    const res = await patch({ windowDays: 7 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rebuildQueued: false })
    expect(state.reconcileQueued).toBe(1)
    expect(state.rebuildQueued).toBe(0)
  })

  it("改图片参数：入队重建（已聚合条目的附件要按新参数重压）", async () => {
    state.settings = { settings: { windowDays: 3, maxImageCount: 2, aiSummaryEnabled: false }, needsRebuild: true }
    const res = await patch({ maxImageCount: 2 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rebuildQueued: true })
    expect(state.rebuildQueued).toBe(1)
    expect(state.reconcileQueued).toBe(0)
  })

  it("POST /refresh 与 /rebuild 返回 202", async () => {
    expect((await app.request("/api/timeline/refresh", { method: "POST" })).status).toBe(202)
    expect((await app.request("/api/timeline/rebuild", { method: "POST" })).status).toBe(202)
    expect(state.reconcileQueued).toBe(1)
    expect(state.rebuildQueued).toBe(1)
  })
})
