import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 改订阅 URL 必须真的重建抓取任务。
 *
 * 这里钉两件事：
 *  1. `requeueAfterUrlChange` 只在 URL 真的变了（且非空）时清错 + 按新地址入队；
 *  2. 管理端 `PUT /api/feeds/:id` 把这个动作接上了 —— 只改 title 时不该触发抓取。
 */

const state = vi.hoisted(() => ({
  session: { user: { id: "admin1", role: "admin" } } as { user: { id: string, role: string } } | null,
  /** 改之前库里存的 URL */
  currentUrl: "https://rsshub.app/old",
  /** 每次 db.update().set() 的入参 */
  updateSets: [] as Record<string, unknown>[],
  /** 真实的清错 + 入队行为由被测模块自己实现，这里只记录 enqueueFetch 的调用 */
  enqueued: [] as [string, string][],
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

vi.mock("../db", () => {
  const table = { id: "id", url: "url" }
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ url: state.currentUrl }] }) }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          state.updateSets.push(values)
          return { where: () => ({ returning: async () => [{ id: "f1" }] }) }
        },
      }),
    },
    feeds: table,
  }
})

vi.mock("../workers", () => ({
  enqueueFetch: async (feedId: string, url: string) => { state.enqueued.push([feedId, url]) },
}))

// CouchDB 不在单测范围内
vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({ insert: async () => ({}), list: async () => ({ rows: [] }), get: async () => ({}) }),
  ensureFeedDatabase: async () => "db_feed",
  ensureTimelineDatabase: async () => "db_user",
}))

const { requeueAfterUrlChange } = await import("../services/feeds")
const { feedsRouter } = await import("../routes/feeds")
const app = new Hono().route("/api/feeds", feedsRouter)

beforeEach(() => {
  state.session = { user: { id: "admin1", role: "admin" } }
  state.currentUrl = "https://rsshub.app/old"
  state.updateSets = []
  state.enqueued = []
})

describe("requeueAfterUrlChange", () => {
  it("URL 变了：清空 errorMessage 并按新地址入队", async () => {
    const changed = await requeueAfterUrlChange("f1", "https://rsshub.app/old", "https://rsshub.app/new")

    expect(changed).toBe(true)
    expect(state.updateSets).toContainEqual({ errorMessage: null })
    expect(state.enqueued).toEqual([["f1", "https://rsshub.app/new"]])
  })

  it("URL 没变或没传：什么都不做", async () => {
    expect(await requeueAfterUrlChange("f1", "same", "same")).toBe(false)
    expect(await requeueAfterUrlChange("f1", "old", undefined)).toBe(false)
    expect(state.updateSets).toEqual([])
    expect(state.enqueued).toEqual([])
  })
})

describe("PUT /api/feeds/:id", () => {
  it("改了 URL：响应里 requeued=true，并按新地址重建任务", async () => {
    const res = await app.request("/api/feeds/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://rsshub.app/new" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ feedId: "f1", updated: true })
    expect(state.enqueued).toEqual([["f1", "https://rsshub.app/new"]])
  })

  it("只改标题：不触发抓取", async () => {
    const res = await app.request("/api/feeds/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ requeued: false })
    expect(state.enqueued).toEqual([])
  })
})
