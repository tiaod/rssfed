import { describe, it, expect } from "vitest"
import { app } from "../app"
import { mcpHandler } from "../routes/mcp"

/**
 * MCP 订阅管理 server 的**无基础设施依赖**测试。
 *
 * 说明：
 *  - 这里只覆盖「不依赖 PostgreSQL / CouchDB / Redis」的断言，能在默认 `pnpm test`
 *    环境下稳定通过，不污染数据。
 *  - 认证拦截（无 token → 401）在查库之前就返回，因此无需 DB。
 *  - 工具注册（initialize / tools/list）通过内部头 `x-rssfed-user-id` 直连
 *    `mcpHandler` 验证，它只返回注册的工具定义，不访问业务数据。
 *  - 涉及真实读写（add/remove/list 订阅、Bot 生命周期等）的端到端验证，见
 *    `scripts/verify-mcp.ts`（需要完整基础设施与测试用户）。
 *
 * 注：import app 会触发 BotKit 尝试连接 PostgreSQL，若数据库不可用会在
 * stderr 打印连接失败信息，但不影响上述断言（与 health.test.ts 相同）。
 */

/** 发送一个 MCP JSON-RPC 请求到 mcpRouter（走完整入口认证） */
async function requestMcp(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

/** 解析 MCP 响应体：SSE（event: message\ndata: {...}）或纯 JSON */
async function parseBody(res: Response): Promise<{ json?: any }> {
  const raw = await res.text()
  let json: any
  try {
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
    const last = dataLines[dataLines.length - 1]
    json = last === undefined ? JSON.parse(raw) : JSON.parse(last)
  } catch {
    json = null
  }
  return { json }
}

describe("MCP 认证拦截", () => {
  it("无 token → 401", async () => {
    const res = await requestMcp("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.status).toBe(401)
  })

  // 注：「无效/吊销/过期 token → 401」需要查询 api_token 表（依赖真实 PostgreSQL），
  // 不属于本文件的无基础设施断言；已在 scripts/verify-mcp.ts 中覆盖。
})

describe("MCP 端点路径兼容（/mcp 与 /mcp/ 等价直达，无重定向）", () => {
  it.each(["/mcp", "/mcp/", "/mcp/anything"])("%s 无 token → 401 且不重定向", async (path) => {
    const res = await requestMcp(path, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.status).toBe(401)
    // 未返回 301/307 location，避免客户端跟随重定向丢失 Authorization 头
    expect(res.headers.get("location")).toBeNull()
  })
})

// 以下通过内部头 x-rssfed-user-id 直连 mcpHandler，仅验证工具注册（不访问业务数据，无需 DB）。
describe("MCP 工具注册", () => {
  async function rpc(method: string, params: any, userId = "test-user-1") {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-rssfed-user-id": userId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const res = await mcpHandler.fetch(req)
    const { json } = await parseBody(res)
    return { res, json }
  }

  it("initialize 返回 rssfed-subscriptions server", async () => {
    const { res, json } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    })
    expect(res.status).toBe(200)
    expect(json?.result?.serverInfo?.name).toBe("rssfed-subscriptions")
  })

  it("tools/list 返回全部 19 个订阅管理工具", async () => {
    const { res, json } = await rpc("tools/list", {})
    expect(res.status).toBe(200)
    const names: string[] = (json?.result?.tools ?? []).map((t: any) => t.name)
    expect(names).toHaveLength(19)
    const expected = [
      "list_subscriptions", "discover_feed", "add_subscription", "remove_subscription",
      "pause_subscription", "resume_subscription", "update_subscription", "refetch_feed",
      "list_bots", "create_bot", "update_bot", "delete_bot", "add_bot_feed",
      "remove_bot_feed", "list_bot_feeds", "organize_bots", "get_feed",
      "list_entries", "search_entries",
    ]
    for (const name of expected) {
      expect(names).toContain(name)
    }
  })
})
