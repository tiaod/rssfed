import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"

// 登录态可切换（默认已登录），用于覆盖 401 分支
const state = vi.hoisted(() => ({
  session: { user: { id: "test-user" } } as { user: { id: string } } | null,
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

// 建库/取库名要连 PostgreSQL 与 CouchDB；代理本身的行为与它们无关，替换成可预测的假实现
vi.mock("../couchdb/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../couchdb/client")>()
  return {
    ...actual,
    ensureFeedDatabase: async (feedId: string) => `feed_${feedId}`,
    ensureBotDatabase: async (botId: string) => `bot_${botId}`,
    ensureUserStateDatabase: async (userId: string) => `user-state_${userId}`,
  }
})

vi.mock("../services/feeds", () => ({
  listSubscriptionsForUser: async () => [
    { feedId: "f1", kind: "feed" },
    { feedId: "bot:b1", kind: "bot" },
  ],
}))

const { app } = await import("../app")
const { couchUrl } = await import("../couchdb/client")

/** 合法库名：本服务前缀 + 24 位随机后缀（见 couchdb/client.ts 的生成规则） */
const FEED_DB = `feed_${"a".repeat(24)}`
const BOT_DB = `bot_${"b".repeat(24)}`

/** 被转发到 CouchDB 的那次请求（拦截 global fetch 捕获） */
let forwarded: { url: string, method: string, headers: Headers, body?: string } | null = null
const realFetch = globalThis.fetch

beforeEach(() => {
  forwarded = null
  state.session = { user: { id: "test-user" } }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    forwarded = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("CouchDB 代理：直通转发", () => {
  it("库名 + 库内路径 + 查询串原样转发到 CouchDB", async () => {
    const res = await app.request(`/api/couchdb/proxy/${FEED_DB}/_changes?since=5&feed=longpoll`)

    expect(res.status).toBe(200)
    expect(forwarded?.url).toBe(`${couchUrl}/${FEED_DB}/_changes?since=5&feed=longpoll`)
  })

  it("只有库名（无库内路径）时转发到库根", async () => {
    await app.request(`/api/couchdb/proxy/${FEED_DB}/`)

    expect(forwarded?.url).toBe(`${couchUrl}/${FEED_DB}/`)
  })

  it("转发时带上 Proxy Auth 头，CouchDB 才能按当前用户鉴权", async () => {
    await app.request(`/api/couchdb/proxy/${BOT_DB}/_all_docs`)

    expect(forwarded?.headers.get("X-Auth-CouchDB-UserName")).toBe("test-user")
    expect(forwarded?.headers.get("X-Auth-CouchDB-Roles")).toBe("user")
    // HMAC-SHA1(secret=COUCHDB_PROXY_SECRET, message=userId)；测试环境 secret 为空串
    expect(forwarded?.headers.get("X-Auth-CouchDB-Token")).toBe(
      createHmac("sha1", "").update("test-user").digest("hex"),
    )
  })

  it("写请求的方法与 body 透传（PUT 文档）", async () => {
    await app.request(`/api/couchdb/proxy/${FEED_DB}/doc-1`, {
      method: "PUT",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    })

    expect(forwarded?.method).toBe("PUT")
    expect(forwarded?.body).toBe(JSON.stringify({ title: "x" }))
  })

  it("文档 id 里的编码字符不会被二次解码（路径按原始分段拼接）", async () => {
    await app.request(`/api/couchdb/proxy/${FEED_DB}/subscription%3Aabc`)

    expect(forwarded?.url).toBe(`${couchUrl}/${FEED_DB}/subscription%3Aabc`)
  })
})

describe("CouchDB 代理：库名白名单", () => {
  it.each([
    ["系统库", "_users"],
    ["非本服务库", "some-other-db"],
    ["后缀长度不对", "feed_abc"],
    ["大写字母", `feed_${"A".repeat(24)}`],
  ])("拒绝 %s（%s）", async (_label, dbName) => {
    const res = await app.request(`/api/couchdb/proxy/${dbName}/_all_docs`)

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_database")
    expect(forwarded).toBeNull()
  })

  it("旧地址 /proxy/feed/<feedId> 明确拒绝并提示刷新页面", async () => {
    const res = await app.request("/api/couchdb/proxy/feed/abc123/_changes")

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string, hint?: string }
    expect(body.error).toBe("invalid_database")
    expect(body.hint).toContain("targets")
  })
})

/**
 * 回归用例：PouchDB 每次建立复制前都会请求「去掉库名段之后的那个路径」拿远端实例的
 * uuid（`api.id` → `genUrl(host, '')`）。配合本代理的地址（/api/couchdb/proxy/<库名>）
 * 就是 GET /api/couchdb/proxy/。
 *
 * 这是每个订阅、每次同步都有的正常请求，必须返回 CouchDB 风格的根信息，
 * 否则前端控制台会刷一屏 404。
 */
describe("CouchDB 代理：PouchDB 实例 uuid 探测", () => {
  it("GET /api/couchdb/proxy/ 返回根信息", async () => {
    const res = await app.request("/api/couchdb/proxy/")

    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).couchdb).toBe("Welcome")
  })

  it("无尾斜杠的 /api/couchdb/proxy 也返回根信息", async () => {
    expect((await app.request("/api/couchdb/proxy")).status).toBe(200)
  })

  it("探测响应故意不含 uuid：带了它 PouchDB 会改复制 id，所有 checkpoint 白失效", async () => {
    const body = await (await app.request("/api/couchdb/proxy/")).json() as Record<string, unknown>

    expect(body.uuid).toBeUndefined()
  })

  it("探测请求不转发到 CouchDB", async () => {
    await app.request("/api/couchdb/proxy/")

    expect(forwarded).toBeNull()
  })
})

describe("GET /api/couchdb/targets", () => {
  it("下发用户状态库与各订阅库的真实库名（含 bot）", async () => {
    const res = await app.request("/api/couchdb/targets")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userState: "user-state_test-user",
      feeds: { f1: "feed_f1" },
      bots: { b1: "bot_b1" },
    })
  })

  it("未登录返回 401", async () => {
    state.session = null

    const res = await app.request("/api/couchdb/targets")

    expect(res.status).toBe(401)
  })
})

describe("CouchDB 代理：认证", () => {
  it("未登录时代理请求返回 401，且不转发", async () => {
    state.session = null

    const res = await app.request(`/api/couchdb/proxy/${FEED_DB}/_all_docs`)

    expect(res.status).toBe(401)
    expect(forwarded).toBeNull()
  })
})
