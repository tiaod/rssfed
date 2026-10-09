import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  settings: {
    settings: { windowDays: 3, maxImageCount: 6, aiSummaryEnabled: false },
    needsRebuild: false,
  },
  reconcileQueued: 0,
  rebuildQueued: 0,
  /** 直连（wait=1）的 reconcile 结果；null 表示模拟「服务端超时仍在跑」 */
  inlineReconcile: null as null | { addedEntries: number, sources: number },
  inlineCalls: 0,
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
    // wait=1 的刷新会**在本请求内**跑一轮聚合：这里用一个可控的替身，
    // 既不碰 CouchDB，也能复现「超时后仍在后台跑」的分支
    reconcileUserTimeline: async () => {
      state.inlineCalls++
      if (!state.inlineReconcile) {
        return await new Promise(() => {}) // 永不 settle：模拟超时
      }
      return { ...state.inlineReconcile, addedEntries: state.inlineReconcile.addedEntries, sources: state.inlineReconcile.sources }
    },
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
  state.inlineReconcile = null
  state.inlineCalls = 0
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

  it("POST /refresh?wait=1：本请求内跑完一轮聚合并带上确切条数（手动同步要一个确定答案）", async () => {
    state.inlineReconcile = { addedEntries: 7, sources: 12 }
    const res = await app.request("/api/timeline/refresh?wait=1", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true, completed: true, added: 7, sources: 12 })
    // 直连跑完了，就不该再入队（同一份工作不该跑两遍）
    expect(state.reconcileQueued).toBe(0)
  })

  it("POST /refresh?wait=1 超时：202 报 completed=false，聚合仍在后台跑（不重复入队）", async () => {
    vi.useFakeTimers()
    try {
      const pending = app.request("/api/timeline/refresh?wait=1", { method: "POST" })
      // 让等待计时器到期（服务端等待上限见 routes/timeline.ts 的 TIMELINE_REFRESH_WAIT_MS）
      await vi.advanceTimersByTimeAsync(60_000)
      const res = await pending
      expect(res.status).toBe(202)
      expect(await res.json()).toMatchObject({ accepted: true, completed: false })
      expect(state.inlineCalls).toBe(1)
      expect(state.reconcileQueued).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
