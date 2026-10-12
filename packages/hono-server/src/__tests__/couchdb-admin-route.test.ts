import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"

/**
 * CouchDB 后台管理页（Fauxton）反代的路由契约。
 *
 * 这里钉住三件事：
 *   1. 准入：只有管理员会话能触发转发（这条路由的转发身份是 CouchDB 的 `_admin`，
 *      而角色头不参与 HMAC 签名，所以这层判断是唯一的准入门槛）；
 *   2. 寻址：`/admin/couchdb/<x>` 原样落到 `{COUCHDB_URL}/<x>`，query 保留，
 *      不按库名做任何白名单（Fauxton 要用到根接口与系统库）；
 *   3. 响应头处理：Content-Type 透传、Location 补前缀、Set-Cookie 丢弃。
 */

/** 登录态可切换（默认管理员），用于覆盖 401 / 403 两个分支 */
const state = vi.hoisted(() => ({
  session: { user: { id: "admin1", role: "admin" } } as { user: { id: string, role: string } } | null,
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

const { app } = await import("../app")
const { couchUrl, setProxySecret } = await import("../couchdb/client")

/** 测试用的固定密钥（避免依赖进程环境里的 COUCHDB_PROXY_SECRET） */
const TEST_SECRET = "unit-test-proxy-secret"
const COUCH_BASE = couchUrl.replace(/\/+$/, "")

/** 被转发到 CouchDB 的那次请求（拦截 global fetch 捕获） */
let forwarded: { url: string, method: string, headers: Headers, body?: string } | null = null
/** 让上游响应可定制（状态码与响应头） */
let upstream: Response
const realFetch = globalThis.fetch

beforeEach(() => {
  forwarded = null
  state.session = { user: { id: "admin1", role: "admin" } }
  setProxySecret(TEST_SECRET)
  upstream = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    // 流式请求体（附件上传）读一次就消耗掉，这里取文本用于断言内容
    const body = init?.body ? await new Response(init.body as ReadableStream).text() : undefined
    forwarded = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body }
    return upstream
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setProxySecret("")
})

describe("CouchDB 控制台反代：准入", () => {
  it("未登录返回 401，且不转发到 CouchDB", async () => {
    state.session = null
    const res = await app.request("/admin/couchdb/_utils/")
    expect(res.status).toBe(401)
    expect(forwarded).toBeNull()
  })

  it("已登录但不是管理员返回 403，且不转发到 CouchDB", async () => {
    state.session = { user: { id: "u1", role: "user" } }
    const res = await app.request("/admin/couchdb/_all_dbs")
    expect(res.status).toBe(403)
    expect(forwarded).toBeNull()
  })
})

describe("CouchDB 控制台反代：转发", () => {
  it("路径与 query 原样落到 CouchDB 根，并以 _admin 身份签名", async () => {
    const res = await app.request("/admin/couchdb/_all_dbs?descending=true")
    expect(res.status).toBe(200)
    expect(forwarded?.url).toBe(`${COUCH_BASE}/_all_dbs?descending=true`)
    expect(forwarded?.method).toBe("GET")
    expect(forwarded?.headers.get("X-Auth-CouchDB-UserName")).toBe("admin1")
    // 角色完全由请求头决定，控制台需要 _admin
    expect(forwarded?.headers.get("X-Auth-CouchDB-Roles")).toBe("_admin")
    expect(forwarded?.headers.get("X-Auth-CouchDB-Token")).toBe(
      createHmac("sha1", TEST_SECRET).update("admin1").digest("hex"),
    )
  })

  it("库名不做白名单：任意库与系统库都转发（Fauxton 要读 _replicator）", async () => {
    await app.request("/admin/couchdb/_replicator/_all_docs")
    expect(forwarded?.url).toBe(`${COUCH_BASE}/_replicator/_all_docs`)
  })

  it("请求体流式透传（Fauxton 上传附件不能被当文本解）", async () => {
    const res = await app.request("/admin/couchdb/db1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "世界" }),
    })
    expect(res.status).toBe(200)
    expect(forwarded?.method).toBe("POST")
    expect(forwarded?.body).toBe(JSON.stringify({ hello: "世界" }))
    expect(forwarded?.headers.get("Content-Type")).toBe("application/json")
  })

  it("前缀本身（含结尾斜杠）重定向到 Fauxton 入口", async () => {
    const res = await app.request("/admin/couchdb")
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/admin/couchdb/_utils/")

    const withSlash = await app.request("/admin/couchdb/")
    expect(withSlash.status).toBe(302)
    expect(withSlash.headers.get("Location")).toBe("/admin/couchdb/_utils/")
  })

  it("Proxy Auth 未就绪（密钥为空）时明确 503，不把 401 留给 Fauxton", async () => {
    setProxySecret("")
    const res = await app.request("/admin/couchdb/_all_dbs")
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe("proxy_auth_not_ready")
    expect(forwarded).toBeNull()
  })
})

describe("CouchDB 控制台反代：响应头", () => {
  it("透传 Content-Type，Location 补回前缀", async () => {
    upstream = new Response("{}", {
      status: 302,
      headers: { "Content-Type": "text/html", "Location": "/db1/_design/x" },
    })
    const res = await app.request("/admin/couchdb/_utils/")
    expect(res.status).toBe(302)
    expect(res.headers.get("Content-Type")).toBe("text/html")
    expect(res.headers.get("Location")).toBe("/admin/couchdb/db1/_design/x")
  })

  it("丢弃 CouchDB 的 Set-Cookie（AuthSession 能绕过 requireAdmin）", async () => {
    upstream = new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": "AuthSession=abc; Path=/; HttpOnly" },
    })
    const res = await app.request("/admin/couchdb/_session")
    expect(res.headers.get("Set-Cookie")).toBeNull()
  })
})
