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
  /** 下次 db.update() 要抛的错误（模拟唯一约束冲突） */
  updateError: null as unknown,
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

vi.mock("../db", () => {
  const table = { id: "id", url: "url", title: "title" }
  return {
    db: {
      // 两处 select 都要能跑：取 before.url、以及冲突后查占用者（id/title）
      select: (cols?: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: async () => [cols?.title ? { id: "dup1", title: "已存在的源" } : { url: state.currentUrl }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          if (state.updateError) {
            const err = state.updateError
            // drizzle 的 update 是惰性的：set() 之后才真正执行，错误在 where() 上抛
            return { where: () => { throw err } }
          }
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

/**
 * 造一个 postgres.js 风格的真 Error。
 *
 * 必须是 Error 实例：Hono 的默认 errorHandler 只接管 `err instanceof Error`，非 Error 会被
 * 原样往外抛（测试里就成了「测试失败而不是 500」）。真实链路里 drizzle 抛的也是 Error。
 */
function pgError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields)
}

beforeEach(() => {
  state.session = { user: { id: "admin1", role: "admin" } }
  state.currentUrl = "https://rsshub.app/old"
  state.updateSets = []
  state.enqueued = []
  state.updateError = null
})

describe("requeueAfterUrlChange", () => {
  it("URL 变了：清空 errorMessage 并按新地址入队", async () => {
    const changed = await requeueAfterUrlChange("f1", "https://rsshub.app/old", "https://rsshub.app/new")

    expect(changed).toBe(true)
    expect(state.updateSets).toContainEqual({ errorMessage: null })
    expect(state.enqueued).toEqual([["f1", "https://rsshub.app/new"]])
  })

  it("URL 变了：丢掉旧地址的条件请求验证器", async () => {
    // 带着新地址去问旧资源的 ETag，服务端可能回 304 —— 新地址永远抓不到内容
    await requeueAfterUrlChange("f1", "https://rsshub.app/old", "https://rsshub.app/new")

    expect(state.updateSets).toContainEqual({
      fetchValidatorUrl: null,
      fetchEtag: null,
      fetchLastModified: null,
      hasFetchValidators: null,
    })
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

  it("改成已被别的源占用的地址：409 + 占用者信息，不是 500", async () => {
    // feeds.url 是唯一列。以前这里把 Postgres 的 23505 原样抛出去，前端只看到
    // `[PUT] ...: 500 Internal Server Error`，既不知道原因也不知道怎么改。
    state.updateError = pgError({ code: "23505", constraint_name: "feeds_url_unique" })

    const res = await app.request("/api/feeds/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://rsshub.app/taken" }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: "feed_url_taken",
      url: "https://rsshub.app/taken",
      existingFeedId: "dup1",
      existingTitle: "已存在的源",
    })
    // 冲突时不能入队，也不能再写一次库
    expect(state.enqueued).toEqual([])
  })

  it("其它唯一约束冲突照旧抛 500（只把 url 冲突翻成 409）", async () => {
    // feeds 上还有 couch_db_name 的唯一约束，不能把它也报成「地址重复」
    state.updateError = pgError({ code: "23505", constraint_name: "feeds_couch_db_name_unique" })

    const res = await app.request("/api/feeds/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://rsshub.app/new" }),
    })

    expect(res.status).toBe(500)
  })

  it("非唯一冲突的错误照旧抛出", async () => {
    state.updateError = pgError({ code: "08006" }) // connection_failure

    const res = await app.request("/api/feeds/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    })

    expect(res.status).toBe(500)
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
