import { Hono } from "hono"
import type { Context, Next } from "hono"
import { createHmac } from "node:crypto"
import {
  couchUrl,
  proxySecret,
  isProxyableDbName,
  ensureFeedDatabase,
  ensureUserStateDatabase,
  ensureTimelineDatabase,
  ensureBotDatabase,
} from "../couchdb/client"
import { listSubscriptionsForUser } from "../services/feeds"
import { auth } from "../auth"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/**
 * 本路由的挂载点（app.ts 用同一常量注册）。
 * 代理要按它从完整请求路径里剥出「库名 + 库内路径」，写成常量避免与挂载点漂移。
 */
export const COUCHDB_ROUTE_PREFIX = "/api/couchdb"

/** 代理前缀（完整路径形式） */
const PROXY_PREFIX = `${COUCHDB_ROUTE_PREFIX}/proxy`

export const couchdbRouter = new Hono<{ Variables: Variables }>()

/**
 * CouchDB 反向代理（Proxy Authentication）。
 *
 * 代理是**直通**的：路径里直接带真实库名，后端不做任何「路径 → 库」的映射：
 *
 *   <method> /api/couchdb/proxy/<库名>/<库内路径>?<query>
 *     → {COUCHDB_URL}/<库名>/<库内路径>?<query>
 *
 * 库名由 GET /api/couchdb/targets 下发，那是「业务 id → 库名」的唯一权威来源 ——
 * 库名是随机生成并持久化在业务表（feeds / bots / user 的 couch_db_name 列）上的，
 * 不能由业务 id 推导，所以只能先取库名再用库名拼代理地址。
 *
 * 代理侧因此只剩两件事：认证（补 Proxy Auth 签名头）与转发；至于「谁有权读哪个库」，
 * 仍由 CouchDB 的库级 _security 兜底（用户状态库限本人 names，feed/bot 库放行 user 角色）。
 */

// 认证中间件：targets 与代理都需要登录态
couchdbRouter.use("/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
})

/**
 * 代理寻址信息（**旧版**：每个订阅源一个库）。
 *
 *   { userState: "user-state_xxx", feeds: { <feedId>: "feed_xxx" }, bots: { <botId>: "bot_xxx" } }
 *
 * 服务端聚合改造后浏览器不再逐源同步，新版客户端改用 `GET /sync-targets`。
 * 这个端点**保留**是为了让缓存了旧前端的 PWA（Service Worker 里的旧 shell 会继续跑一段时间）
 * 不至于整体失效：旧客户端拿不到 feed 库名会把每个源标成同步失败，用户看到的是「一片红」。
 * 等旧前端淘汰后可以连同 `feeds`/`bots` 一起删掉。
 *
 * 顺带 ensure 一次：订阅是刚建立时库可能还不存在，先把库建好，前端不必关心建库时机。
 * 已有库名的都是纯读（见 couchdb/client.ts 的 resolveDatabase），所以这个接口对老订阅几乎零成本。
 */
couchdbRouter.get("/targets", async (c) => {
  const userId = c.get("userId")
  const subscriptions = await listSubscriptionsForUser(userId)

  const feeds: Record<string, string> = {}
  const bots: Record<string, string> = {}
  await Promise.all(
    subscriptions.map(async (sub) => {
      if (sub.kind === "bot") {
        // 订阅文档里 bot 的 feedId 形如 `bot:<botId>`
        const botId = String(sub.feedId).replace(/^bot:/, "")
        if (botId) bots[botId] = await ensureBotDatabase(botId)
        return
      }
      feeds[sub.feedId] = await ensureFeedDatabase(sub.feedId)
    }),
  )

  return c.json({ userState: await ensureUserStateDatabase(userId), feeds, bots })
})

/**
 * 代理寻址信息（**新版**：同步面收敛成两个库）。
 *
 *   { userState: "user-state_xxx", timeline: "user-timeline_xxx" }
 *
 * 浏览器现在只做两件事：单向 live 复制 timeline 库（服务端聚合好的条目）、
 * 双向同步 userState 库（订阅关系与已读/收藏）。这里**不再** ensure 每个 feed 库 ——
 * 那曾是这个接口最重的一部分（订阅源上百个就是上百次库名查询）。
 */
couchdbRouter.get("/sync-targets", async (c) => {
  const userId = c.get("userId")
  const [userState, timeline] = await Promise.all([
    ensureUserStateDatabase(userId),
    ensureTimelineDatabase(userId),
  ])
  return c.json({ userState, timeline })
})

/**
 * PouchDB 的「实例 uuid 探测」路径。
 *
 * PouchDB 每次建立复制前都会调用远端库的 `id()`（内部 `api.id` → `genUrl(host, '')`），
 * 请求「去掉库名段之后的那个路径」来拿远端 CouchDB 实例的 uuid；配合本代理的地址
 * （远端库 = /api/couchdb/proxy/<库名>）就是：
 *
 *   GET /api/couchdb/proxy/
 *
 * 这是**每个订阅、每次复制**都会发的正常请求，不是脏数据：拿不到 uuid 时 PouchDB 会
 * 回退用远端库 URL 当复制 id，功能不受影响，只是控制台会刷一屏 404。
 *
 * **故意不返回 uuid**：`api.id` 一旦拿到 uuid，复制 id 会从「远端库 URL」变成
 * 「uuid + 库名」，所有既有 checkpoint 立即失效 —— 每个订阅白跑一次全量重同步。
 * 返回不含 uuid 的根信息，既能消掉 404，又让复制 id（checkpoint）保持不变。
 */
const couchRootInfo = {
  couchdb: "Welcome",
  version: "rssfed-proxy",
  vendor: { name: "RSSFed" },
}

couchdbRouter.all("/proxy/*", async (c) => {
  // c.req.path 是完整请求路径（含挂载点），按 PROXY_PREFIX 剥出库名与库内路径
  const segments = c.req.path.slice(PROXY_PREFIX.length).split("/").filter(Boolean)

  // 只剩代理前缀本身：PouchDB 的实例 uuid 探测（见 couchRootInfo）
  if (segments.length === 0) return c.json(couchRootInfo)

  let dbName: string
  try {
    dbName = decodeURIComponent(segments[0]!)
  } catch {
    // 非法百分号转义
    return c.json({ error: "invalid_database" }, 400)
  }

  if (!isProxyableDbName(dbName)) {
    // 白名单挡住 _users/_replicator 等系统库与路径注入；实践中还常见于
    // 前端仍是旧版本（旧地址形如 /proxy/feed/<feedId>）在打新代理
    return c.json(
      {
        error: "invalid_database",
        reason: `"${dbName}" 不是本服务可代理的库名`,
        hint: "库名由 GET /api/couchdb/targets 下发；若前端还在用 /proxy/feed/<feedId> 这类旧地址，刷新页面即可拿到新版本",
      },
      400,
    )
  }

  // 库内相对路径按原始（未解码）分段拼接：文档 id 里的特殊字符不能被二次编码/解码。
  // 只有库名段本身需要解码（库名只含小写字母数字，解码不会引入新的路径分隔符）。
  const restPath = `/${segments.slice(1).join("/")}`
  return proxyToCouchDb(c, dbName, restPath)
})

/** 通用 CouchDB 代理转发逻辑（认证已在中间件完成） */
async function proxyToCouchDb(c: Context<{ Variables: Variables }>, dbName: string, restPath: string) {
  const userId = c.get("userId")

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
