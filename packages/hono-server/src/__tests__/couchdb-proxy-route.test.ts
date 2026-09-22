import { describe, expect, it, vi } from "vitest"

// 只验证路由匹配，不验证登录态：让认证中间件直接放行
vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => ({ user: { id: "test-user" } }) },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

const { app } = await import("../app")

/**
 * 回归用例：PouchDB 每次建立复制前都会请求「去掉库名段之后的那个路径」拿远端实例的
 * uuid（`api.id` → `genUrl(host, '')`）：
 *   user-state 复制 → /api/couchdb/proxy/
 *   每个 feed 复制  → /api/couchdb/proxy/feed/
 *   每个 bot 复制   → /api/couchdb/proxy/bot/
 * 这些是每个订阅、每次同步都有的正常请求，必须返回 CouchDB 风格的根信息，
 * 否则前端控制台会刷一屏 404（曾据此误判为「订阅 feedId 为空」）。
 */
describe("CouchDB 代理：PouchDB 实例 uuid 探测路径", () => {
  it("GET /api/couchdb/proxy/ 返回根信息（user-state 复制的探测）", async () => {
    const res = await app.request("/api/couchdb/proxy/")
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.couchdb).toBe("Welcome")
  })

  it("GET /api/couchdb/proxy/feed/ 返回根信息（每个 feed 复制的探测）", async () => {
    const res = await app.request("/api/couchdb/proxy/feed/")
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).couchdb).toBe("Welcome")
  })

  it("GET /api/couchdb/proxy/bot/ 返回根信息", async () => {
    const res = await app.request("/api/couchdb/proxy/bot/")
    expect(res.status).toBe(200)
  })

  it("探测响应故意不含 uuid：带了它 PouchDB 会改复制 id，所有 checkpoint 白失效", async () => {
    const res = await app.request("/api/couchdb/proxy/feed/")
    const body = await res.json() as Record<string, unknown>
    expect(body.uuid).toBeUndefined()
  })

  it("CouchDB 保留段不会被当成 feedId 去创建垃圾库（_changes → 400）", async () => {
    const res = await app.request("/api/couchdb/proxy/feed/_changes?since=0")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid feedId" })
  })

  it("bot 保留段同样被拒绝", async () => {
    const res = await app.request("/api/couchdb/proxy/bot/_all_docs")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid botId" })
  })
})
