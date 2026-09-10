/**
 * 验证 /mcp 与 /mcp/ 双路径都直达 MCP handler（无重定向）。
 * 运行：pnpm tsx scripts/verify-mcp-slash.ts
 */
import "dotenv/config"
import { app } from "../src/app"
import { createToken } from "../src/services/api-token"
import { db, apiToken } from "../src/db"
import { eq } from "drizzle-orm"

const USER_ID = process.env.MCP_TEST_USER_ID ?? "RtbOjQ0dXGbyepZTBizq8z4nYYUmE7nQ"

async function parseBody(res: Response) {
  const raw = await res.text()
  let json: any
  try {
    const dl = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    json = dl.length ? JSON.parse(dl[dl.length - 1]) : JSON.parse(raw)
  } catch { json = null }
  return { raw, json }
}

async function main() {
  const { token, record } = await createToken(USER_ID, "slash-verify")

  const paths = ["/mcp", "/mcp/", "/mcp/foo"]
  for (const p of paths) {
    // 无 token：应 401（说明路由直达 handler，而非 404/重定向）
    const noAuth = await app.fetch(new Request(`http://x${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }))
    console.log(`${p} 无token -> ${noAuth.status} (${noAuth.headers.get("location") ?? "no-redirect"}) ${noAuth.status === 401 ? "✅ 直达handler" : "❌"}`)

    // 带 token：initialize 应 200
    const init = await app.fetch(new Request(`http://x${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v", version: "1" } } }),
    }))
    const body = await parseBody(init)
    const ok = init.status === 200 && init.headers.get("location") === null
    console.log(`${p} token -> ${init.status} ${ok ? "✅ 200直达" : "❌"} ${body.raw.includes("rssfed-subscriptions") ? "server正确" : ""}`)
  }

  await db.delete(apiToken).where(eq(apiToken.id, record.id))
  console.log("cleanup done")
}
main().catch((e) => { console.error(e); process.exit(1) })
