import { Hono } from "hono"
import type { Context } from "hono"
import { createHmac } from "node:crypto"
import { couchUrl, proxySecret } from "./client"

/**
 * CouchDB 后台管理页（Fauxton）的反向代理。
 *
 *   GET /admin/couchdb/_utils/...   → {COUCHDB_URL}/_utils/...
 *   GET /admin/couchdb/<任意库或根接口> → {COUCHDB_URL}/<同路径>
 *
 * ## 为什么是一整段路径前缀，而不是只转 `/_utils`
 *
 * Fauxton 自己算 API 根：它取 `location.pathname` 与配置里的 `host: "../"` 做 URL resolve。
 * 页面落在 `/admin/couchdb/_utils/` 时，算出来的根正好是 `/admin/couchdb/`，
 * 于是它接下来会去打 `/admin/couchdb/_all_dbs`、`/admin/couchdb/<库名>/_all_docs`
 * —— 也就是说**凡是 Fauxton 用得到的东西都必须挂在同一个前缀下**，只转 `_utils` 子树会得到
 * 一个能渲染、但每一条数据请求都 404 的空壳。
 *
 * ## 身份：Proxy Authentication + `_admin`
 *
 * 不用管理员 Basic Auth，而是复用本服务同步代理那套 Proxy Authentication（见 routes/couchdb.ts）：
 * `COUCHDB_PROXY_SECRET` 签出的 token + 用户名 + **角色头**。区别只在于角色给的是 `_admin`。
 *
 * ⚠️ 角色头不参与 HMAC 签名（token 只签用户名），CouchDB 完全信任 `X-Auth-CouchDB-Roles`
 * —— 也就是说「这段代码会不会被以 _admin 身份执行」唯一取决于挂载点外面那层 requireAdmin
 * （见 app.ts）。所以本路由**不能**挂到任何面向普通用户的路径前缀下面，
 * 也不能像同步代理那样按库名白名单兜底：Fauxton 要的就是任意库 + 系统库 + 根接口。
 */
export const COUCHDB_ADMIN_PREFIX = "/admin/couchdb"

/** 裸访问前缀时的落地页 */
const FAUXTON_ENTRY = `${COUCHDB_ADMIN_PREFIX}/_utils/`

/** 上游响应里值得透传的头（见 forwardHeaders 的说明） */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "content-disposition",
] as const

export const couchdbAdminApp = new Hono<{ Variables: { userId: string } }>()

/** 前缀本身不再返回 CouchDB 根信息，直接把管理员送进 Fauxton 界面 */
couchdbAdminApp.get("/", (c) => c.redirect(FAUXTON_ENTRY, 302))

couchdbAdminApp.all("/*", async (c: Context<{ Variables: { userId: string } }>) => {
  // 启动窗口内（configureProxyAuth 还没写完配置）密钥可能还是空的：
  // 这时转发出去只会被 CouchDB 判 401，在 Fauxton 里表现为「让你重新登录」，
  // 完全看不出真实原因。直接失败并给出可定位的原因。
  if (!proxySecret) {
    return c.json({
      error: "proxy_auth_not_ready",
      reason: "COUCHDB_PROXY_SECRET 尚未就绪（server 启动时会写入并同步到 CouchDB 配置）",
      hint: "稍后重试；若持续出现，检查 server 启动日志里的 configureProxyAuth 报错",
    }, 503)
  }

  const userId = c.get("userId")

  // c.req.path 是完整请求路径（含挂载点），去掉前缀就是 CouchDB 里的原始路径。
  // 原始分段不做解码：文档 id / 库名里的特殊字符不能被二次编码或解码。
  const restPath = c.req.path.slice(COUCHDB_ADMIN_PREFIX.length)
  // 只带前缀或前缀斜杠：并入 Fauxton 入口（与上面的 get("/") 同一语义）
  if (restPath === "" || restPath === "/") return c.redirect(FAUXTON_ENTRY, 302)

  const queryString = new URL(c.req.url).search
  const targetUrl = `${couchUrl.replace(/\/+$/, "")}${restPath}${queryString}`

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD"
  // 请求体**流式**转发：Fauxton 要传附件，`c.req.text()` 会把二进制按 UTF-8 解坏。
  // Node 的 fetch 对流式请求体要求显式 duplex。
  const init: RequestInit & { duplex?: "half" } = {
    method: c.req.method,
    headers: buildAdminProxyHeaders(userId, c.req.raw.headers),
    ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}),
  }

  const resp = await fetch(targetUrl, init)

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: forwardResponseHeaders(resp.headers),
  })
})

/**
 * 构造转发头：Proxy Authentication 签名 + `_admin` 角色。
 *
 * 刻意不透传 Accept-Encoding 与 Cookie：
 *   - Accept-Encoding 交给 fetch 自己协商并解压，否则拿到的压缩体没法直接交付浏览器；
 *   - Cookie（含 CouchDB 的 AuthSession）对本路由没有意义——身份来自上面的头。
 */
function buildAdminProxyHeaders(userId: string, incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Auth-CouchDB-UserName": userId,
    // 控制台需要 _admin：Fauxton 要读任意库、系统库（_replicator/_users）与根级接口
    "X-Auth-CouchDB-Roles": "_admin",
    "X-Auth-CouchDB-Token": createHmac("sha1", proxySecret).update(userId).digest("hex"),
  }
  const contentType = incoming.get("Content-Type")
  if (contentType) headers["Content-Type"] = contentType
  const accept = incoming.get("Accept")
  if (accept) headers["Accept"] = accept
  return headers
}

/**
 * 构造回给浏览器的响应头。
 *
 * 只挑必要的几个：Content-Type 是硬要求（Fauxton 的 js/css/png 都靠它），
 * 其余是让静态资源能走缓存。
 *
 * 三个刻意**不透传**的头：
 *   - Content-Length / Content-Encoding：上游响应由 fetch 自行解压，长度与实体已不一致；
 *     透传会让浏览器按错误的长度/编码解析，表现为白屏或资源损坏；
 *   - Set-Cookie：CouchDB 的 AuthSession 是一条能绕过 requireAdmin 的长期凭据，
 *     而代理认证根本不需要它，不让它落到浏览器上。
 */
function forwardResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name)
    if (value) headers.set(name, value)
  }
  // Location 是 CouchDB 根路径（如 /dbname/_design/x），补回本路由前缀，
  // 否则浏览器一跳就出了 /admin/couchdb，落到前端或后端的根路径上。
  const location = upstream.get("location")
  if (location?.startsWith("/")) headers.set("Location", `${COUCHDB_ADMIN_PREFIX}${location}`)
  return headers
}
