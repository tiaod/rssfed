import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { isOriginAllowed } from "./config"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { userRouter } from "./routes/user"
import { userTokensRouter } from "./routes/user-tokens"
import { couchdbRouter, COUCHDB_ROUTE_PREFIX } from "./routes/couchdb"
import { timelineRouter, TIMELINE_ROUTE_PREFIX } from "./routes/timeline"
import { siteSettingsPublicRouter, siteSettingsAdminRouter } from "./routes/site-settings"
import { mcpRouter } from "./routes/mcp"
import { instance } from "./bots"
import { storage } from "./storage"
import { bullBoardApp } from "./bullboard"
import { couchdbAdminApp, COUCHDB_ADMIN_PREFIX } from "./couchdb/admin-console"
import { requireAdmin } from "./middleware/require-admin"

const app = new Hono()

app.use("/api/*", cors({
  // 回调形式：允许白名单 + 局域网私有网段（手机调试）；拒绝时返回 null（不带 CORS 头）
  origin: (origin) => (origin && isOriginAllowed(origin) ? origin : null),
  credentials: true,
}))

app.use("/api/auth/*", async (c) => {
  return auth.handler(c.req.raw)
})

app.route("/api/feeds", feedsRouter)
app.route("/api/bots", botsRouter)
app.route("/api/user", userRouter)
app.route("/api/user/tokens", userTokensRouter)
app.route(COUCHDB_ROUTE_PREFIX, couchdbRouter)
app.route(TIMELINE_ROUTE_PREFIX, timelineRouter)
app.route("/api/site-settings", siteSettingsPublicRouter)
app.route("/api/admin/site-settings", siteSettingsAdminRouter)

// MCP server（订阅管理 AI 工具）：须在 BotKit 兜底 app.all("*") 之前注册
app.route("/mcp", mcpRouter)

app.get("/api/health", (c) => c.json({ status: "ok" }))

/**
 * 附件文件代理：未配置 STORAGE_S3_PUBLIC_DOMAIN 时，浏览器 <img> 经本服务读取 S3 对象。
 * key 含目录斜杠，用通配路径匹配；对象不存在返回 404。
 */
app.get("/api/files/*", async (c) => {
  const key = c.req.path.replace("/api/files/", "")
  if (!key) return c.json({ error: "missing key" }, 400)
  try {
    const { content, contentType } = await storage.readWithMeta(key)
    return c.body(new Uint8Array(content), 200, { "Content-Type": contentType })
  } catch {
    return c.json({ error: "not found" }, 404)
  }
})

// BullMQ 任务看板：BullBoard 自身无鉴权，公网裸奔等于公开任务数据、
// 失败堆栈和「重试/清理」按钮，因此这里强制管理员校验。
// 看板 UI 与静态资源都在 /admin/queues 下，精确路径与子路径都要挂中间件。
// （须在 app.all("*") 兜底之前注册，否则被 BotKit 截胡）
app.use("/admin/queues", requireAdmin)
app.use("/admin/queues/*", requireAdmin)
app.route("/admin/queues", bullBoardApp)

// CouchDB 后台管理页（Fauxton）反代：和队列看板同一套管理员网关。
// 它比队列看板更敏感——转发身份是 CouchDB 的 `_admin`（由路由内的角色头指定，
// 而角色头不参与签名校验），能读写任意库、系统库与根级接口，
// 所以 requireAdmin 是它**唯一**的准入条件，别把它摘掉：
// 这条路由公网可达（Caddyfile 的 @backend 白名单里带着 /admin/*，不再 404 屏蔽）。
// （同样须在 app.all("*") 兜底之前注册）
app.use(COUCHDB_ADMIN_PREFIX, requireAdmin)
app.use(`${COUCHDB_ADMIN_PREFIX}/*`, requireAdmin)
app.route(COUCHDB_ADMIN_PREFIX, couchdbAdminApp)

// BotKit ActivityPub 端点
app.all("*", async (c) => instance.fetch(c.req.raw))

export { app }
