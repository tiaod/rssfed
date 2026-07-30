 import { Hono } from "hono"
import { createHmac } from "node:crypto"
import { couchUrl, proxySecret, userDbName } from "../couchdb/client"
import { auth } from "../auth"

export const coucdbRouter = new Hono()

/**
 * 通用 CouchDB 反向代理（Proxy Authentication）。
 *
 * 浏览器 → Hono（同源）→ 添加 Proxy Auth header → CouchDB
 *
 * 路径格式：/api/couchdb/proxy/<剩余路径>
 * 剩余路径会拼接到用户专属库的 URL 上。
 *
 * 例：
 *   POST /api/couchdb/proxy/_find
 *   → POST http://couchdb:5984/rssfed-user:{userId}/_find
 *   + headers: X-Auth-CouchDB-UserName, X-Auth-CouchDB-Token
 */
coucdbRouter.all("/proxy/*", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)

  const userId = session.user.id
  const dbName = userDbName(userId)

  // 提取剩余路径（去掉 /api/couchdb/proxy 前缀）
  const restPath = c.req.path.replace("/api/couchdb/proxy", "") || "/"
  const queryString = new URL(c.req.url).search
  const targetUrl = `${couchUrl.replace(/\/+$/, "")}/${dbName}${restPath}${queryString}`

  // HMAC-SHA1 签名：CouchDB 用相同 secret 验证
  const token = createHmac("sha1", proxySecret).update(userId).digest("hex")

  // 构建转发请求
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

  // 透传 CouchDB 响应
  const respBody = await resp.text()
  return new Response(respBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json",
    },
  })
})
