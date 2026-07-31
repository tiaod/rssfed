import { Hono } from "hono"
import type { Context, Next } from "hono"
import { createHmac } from "node:crypto"
import { couchUrl, proxySecret, userStateDbName, feedDbName, ensureUserStateDatabase } from "../couchdb/client"
import { auth } from "../auth"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

export const coucdbRouter = new Hono<{ Variables: Variables }>()

/**
 * CouchDB 反向代理（Proxy Authentication）。
 *
 * 支持两种目标库：
 *   /api/couchdb/proxy/user-state/<剩余路径>  →  user-state:{userId}
 *   /api/couchdb/proxy/feed/:feedId/<剩余路径> →  feed:{feedId}
 *
 * Hono 自动添加 Proxy Auth header 后转发到 CouchDB。
 * 这样浏览器端 PouchDB 可以通过同源请求同步 feed 库和用户状态库。
 */

// 认证中间件：校验 session，并把 userId 写入 context
coucdbRouter.use("/proxy/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
})

coucdbRouter.all("/proxy/user-state/*", async (c) => {
  const userId = c.get("userId")
  // 自动创建用户状态库（幂等）
  await ensureUserStateDatabase(userId)
  return proxyToCouchDb(c, userStateDbName(userId))
})

coucdbRouter.all("/proxy/feed/:feedId/*", async (c) => {
  const { feedId } = c.req.param()
  return proxyToCouchDb(c, feedDbName(feedId))
})

/** 通用 CouchDB 代理转发逻辑（认证已在中间件完成） */
async function proxyToCouchDb(c: Context<{ Variables: Variables }>, dbName: string) {
  const userId = c.get("userId")

  // 提取剩余路径
  // /api/couchdb/proxy/user-state/<rest> 或 /api/couchdb/proxy/feed/:feedId/<rest>
  // 需要去掉 /api/couchdb/proxy/ 前缀后的第一段（user-state 或 feed/{id}）
  const prefix = "/api/couchdb/proxy/"
  const restPath = c.req.path.slice(prefix.length).replace(/^[^/]+(?:\/[^/]+)?/, "") || "/"
  const queryString = new URL(c.req.url).search
  const targetUrl = `${couchUrl.replace(/\/+$/, "")}/${dbName}${restPath}${queryString}`

  // HMAC-SHA1 签名
  const token = createHmac("sha1", proxySecret).update(userId).digest("hex")

  const headers: Record<string, string> = {
    "X-Auth-CouchDB-UserName": userId,
    "X-Auth-CouchDB-Token": token,
    "Content-Type": c.req.header("Content-Type") || "application/json",
  }
  const accept = c.req.header("Accept")
  if (accept) headers["Accept"] = accept

  const body = c.req.method === "GET" || c.req.method === "HEAD"
    ? undefined
    : await c.req.text()

  const resp = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body,
  })

  const respBody = await resp.text()
  return new Response(respBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json",
    },
  })
}
