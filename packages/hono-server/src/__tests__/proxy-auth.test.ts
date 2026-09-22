import { describe, expect, it } from "vitest"
import {
  isProxyHandlerConfigured,
  isProxyHandlerLoaded,
  verifyProxyAuthReady,
  type FetchLike,
} from "../couchdb/proxy-auth"

const BASE = "http://couchdb:5984/"
const AUTH = "Basic YWRtaW46cHc="
const CONFIGURED_VALUE =
  "{chttpd_auth, cookie_authentication_handler}, {chttpd_auth, proxy_authentication_handler}, {chttpd_auth, default_authentication_handler}"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sessionHandlers(handlers: string[]) {
  return jsonResponse({
    ok: true,
    userCtx: { name: null, roles: [] },
    info: { authentication_handlers: handlers },
  })
}

describe("isProxyHandlerLoaded", () => {
  it("运行时已挂载 proxy handler 时返回 true", async () => {
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toBe("http://couchdb:5984/_session")
      return sessionHandlers(["cookie", "proxy", "default"])
    }
    await expect(isProxyHandlerLoaded(BASE, fetchImpl)).resolves.toBe(true)
  })

  it("未挂载（线上事故时的状态）返回 false", async () => {
    const fetchImpl: FetchLike = async () => sessionHandlers(["cookie", "default"])
    await expect(isProxyHandlerLoaded(BASE, fetchImpl)).resolves.toBe(false)
  })

  it("CouchDB 不可达时返回 false 而不是抛错", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED")
    }
    await expect(isProxyHandlerLoaded(BASE, fetchImpl)).resolves.toBe(false)
  })
})

describe("isProxyHandlerConfigured", () => {
  it("节点配置里含 proxy_authentication_handler 时返回 true", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe("http://couchdb:5984/_node/_local/_config/chttpd/authentication_handlers")
      expect(init?.headers).toEqual({ Authorization: AUTH })
      return new Response(JSON.stringify(CONFIGURED_VALUE))
    }
    await expect(isProxyHandlerConfigured(BASE, AUTH, fetchImpl)).resolves.toBe(true)
  })

  it("配置写入失败（如管理员权限不足）时返回 false", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "unauthorized" }, 401)
    await expect(isProxyHandlerConfigured(BASE, AUTH, fetchImpl)).resolves.toBe(false)
  })
})

describe("verifyProxyAuthReady", () => {
  it("已挂载时不打任何告警", async () => {
    const logs: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toBe("http://couchdb:5984/_session")
      return sessionHandlers(["cookie", "proxy", "default"])
    }

    const ok = await verifyProxyAuthReady({
      base: BASE,
      authorization: AUTH,
      fetchImpl,
      log: (m) => logs.push(m),
    })

    expect(ok).toBe(true)
    expect(logs).toEqual([])
  })

  it("配置已写入但运行时未挂载时，告警指向挂载的 ini 与重启动作", async () => {
    const logs: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      if (url === "http://couchdb:5984/_session") return sessionHandlers(["cookie", "default"])
      if (url.endsWith("/_config/chttpd/authentication_handlers")) {
        return new Response(JSON.stringify(CONFIGURED_VALUE))
      }
      throw new Error(`unexpected url: ${url}`)
    }

    const ok = await verifyProxyAuthReady({
      base: BASE,
      authorization: AUTH,
      fetchImpl,
      log: (m) => logs.push(m),
    })

    expect(ok).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("00-proxy-auth.ini")
    expect(logs[0]).toContain("restart couchdb")
  })

  it("配置都没写进去时，告警指向管理员凭证", async () => {
    const logs: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      if (url === "http://couchdb:5984/_session") return sessionHandlers(["cookie", "default"])
      if (url.endsWith("/_config/chttpd/authentication_handlers")) {
        return new Response(JSON.stringify("{chttpd_auth, cookie_authentication_handler}"))
      }
      throw new Error(`unexpected url: ${url}`)
    }

    const ok = await verifyProxyAuthReady({
      base: BASE,
      authorization: AUTH,
      fetchImpl,
      log: (m) => logs.push(m),
    })

    expect(ok).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("COUCHDB_USER")
  })
})
