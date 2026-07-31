import { Hono } from "hono"
import { createHmac } from "node:crypto"
import { couchUrl, proxySecret, userStateDbName, feedDbName, ensureUserStateDatabase } from "../couchdb/client"
import { auth } from "../auth"

export const coucdbRouter = new Hono()

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
coucdbRouter.all("/proxy/user-state/*", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const dbName = userStateDbName(session.user.id)
  // 自动创建用户状态库（幂等）
  await ensureUserStateDatabase(session.user.id)
  return proxyToCouchDb(c, dbName)
})

coucdbRouter.all("/proxy/feed/:feedId/*", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const { feedId } = c.req.param()
  const dbName = feedDbName(feedId)
  return proxyToCouchDb(c, dbName)
})

/** 通用 CouchDB 代理转发逻辑 */
async function proxyToCouchDb(c: any, dbName: string) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const userId = session.user.id

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
