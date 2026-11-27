import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `POST /api/feeds/discover` 必须登录。
 *
 * 这个端点会按请求体里的 URL **真实发一次 HTTP 请求**（解析订阅源）。没有会话时它就是
 * 一个免鉴权的 SSRF 入口 —— 2026-11 实测未登录 POST `{"url":"http://127.0.0.1:5984/"}`
 * 能连上内网 CouchDB 并读回响应体（返回 "Unrecognized feed format" 而不是"连不上"），
 * 指 `/_all_dbs` 则回 401，同样证明请求真的到达了目标。
 *
 * 这里钉两件事：
 *  1. 未登录 → 401，且**根本不会去解析 URL**（一个请求都不发）；
 *  2. 已登录 → 照常放行（别把正常订阅路径也堵了）。
 *
 * 地址本身的白名单/黑名单是另一层（rss/ssrf-guard.ts），不在这个文件的范围里。
 */

const state = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  /** 记录"有没有真的去抓"：未登录时必须为 0 */
  parseCalls: [] as string[],
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

vi.mock("../rss/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rss/parser")>()
  return {
    ...actual,
    parseFeedUrl: async (url: string) => {
      state.parseCalls.push(url)
      return { title: "测试源", items: [] }
    },
  }
})

vi.mock("../workers", () => ({ enqueueOwnerFetch: async () => {} }))

vi.mock("../couchdb/client", () => ({
  // get 抛错 = FeedDoc 还不存在，于是 seedFeedDoc 走首次插入路径（生产里就是这个行为）
  createCouchDb: () => ({ get: async () => { throw new Error("not found") }, insert: async () => ({}) }),
  ensureTimelineDatabase: async () => "db_user",
}))

vi.mock("../db", () => ({
  db: {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => ({}) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  bots: { id: "id" },
}))

const { feedsRouter } = await import("../routes/feeds")
const app = new Hono().route("/api/feeds", feedsRouter)

function post(url: string) {
  return app.request("/api/feeds/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
}

beforeEach(() => {
  state.session = null
  state.parseCalls = []
})

describe("POST /api/feeds/discover 鉴权", () => {
  it("未登录：401，且一个请求都不发出去", async () => {
    const res = await post("http://127.0.0.1:5984/")

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
    // 关键：被拦在发请求之前，否则鉴权只是"事后返回 401"，内网已经被探过了
    expect(state.parseCalls).toEqual([])
  })

  it("已登录：照常解析并注册", async () => {
    state.session = { user: { id: "u1" } }

    const res = await post("https://example.com/feed.xml")

    expect(res.status).toBe(200)
    expect(state.parseCalls).toEqual(["https://example.com/feed.xml"])
    expect(await res.json()).toMatchObject({ title: "测试源" })
  })
})
