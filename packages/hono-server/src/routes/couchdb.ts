import { Hono } from "hono"
import type { Context, Next } from "hono"
import { createHmac } from "node:crypto"
import { couchUrl, proxySecret, ensureFeedDatabase, ensureUserStateDatabase, ensureBotDatabase } from "../couchdb/client"
import { auth } from "../auth"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

export const couchdbRouter = new Hono<{ Variables: Variables }>()

/**
 * CouchDB 反向代理（Proxy Authentication）。
 *
 * 支持三种目标库：
 *   /api/couchdb/proxy/user-state/<剩余路径>  →  user-state-{userId}
 *   /api/couchdb/proxy/feed/:feedId/<剩余路径> →  feed-{feedId}
 *   /api/couchdb/proxy/bot/:botId/<剩余路径>   →  bot-{botId}（bot 产出库，全登录用户可读）
 *
 * Hono 自动添加 Proxy Auth header 后转发到 CouchDB。
 * 这样浏览器端 PouchDB 可以通过同源请求同步 feed 库、bot 产出库和用户状态库。
 */

// 认证中间件：校验 session，并把 userId 写入 context
couchdbRouter.use("/proxy/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
})

couchdbRouter.all("/proxy/user-state/*", async (c) => {
  const userId = c.get("userId")
  // 自动创建用户状态库（幂等），并返回其库名
  const dbName = await ensureUserStateDatabase(userId)
  return proxyToCouchDb(c, dbName, "/api/couchdb/proxy/user-state")
})

couchdbRouter.all("/proxy/feed/:feedId/*", async (c) => {
  const { feedId } = c.req.param()
  const dbName = await ensureFeedDatabase(feedId)
  return proxyToCouchDb(c, dbName, `/api/couchdb/proxy/feed/${feedId}`)
})

couchdbRouter.all("/proxy/bot/:botId/*", async (c) => {
  const { botId } = c.req.param()
  const dbName = await ensureBotDatabase(botId)
  return proxyToCouchDb(c, dbName, `/api/couchdb/proxy/bot/${botId}`)
})

/** 通用 CouchDB 代理转发逻辑（认证已在中间件完成） */
async function proxyToCouchDb(c: Context<{ Variables: Variables }>, dbName: string, stripPrefix: string) {
  const userId = c.get("userId")

  // 剥离代理前缀，得到目标库内的相对路径（如 /doc-id 或 /）
  const restPath = c.req.path.slice(stripPrefix.length) || "/"
  const queryString = new URL(c.req.url).search
  const targetUrl = `${couchUrl.replace(/\/+$/, "")}/${dbName}${restPath}${queryString}`

  const resp = await fetch(targetUrl, {
    method: c.req.method,
    headers: buildProxyHeaders(c, userId),
    body: c.req.method === "GET" || c.req.method === "HEAD"
      ? undefined
      : await c.req.text(),
  })

  // 流式透传响应体与关键头。
  // 不能用 await resp.text() 缓冲：live 长轮询（_changes?feed=longpoll）会一直挂起等待
  // 心跳，浏览器刷新/断开后这里仍占着一个到 CouchDB 的连接，反复刷新会堆积残留连接，
  // 最终击穿 CouchDB 并发上限导致所有同步请求饿死。流式转发让上游连接随浏览器断开而释放。
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json",
    },
  })
}

/** 构造带 Proxy Auth 签名的转发请求头 */
function buildProxyHeaders(c: Context<{ Variables: Variables }>, userId: string): Record<string, string> {
  // HMAC-SHA1 签名
  const token = createHmac("sha1", proxySecret).update(userId).digest("hex")

  const headers: Record<string, string> = {
    "X-Auth-CouchDB-UserName": userId,
    "X-Auth-CouchDB-Token": token,
    // 授予 user 角色，满足 feed 库 members.roles 授权（roles 完全来自此头）
    "X-Auth-CouchDB-Roles": "user",
    "Content-Type": c.req.header("Content-Type") || "application/json",
  }
  const accept = c.req.header("Accept")
  if (accept) headers["Accept"] = accept
  return headers
}
