import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { isOriginAllowed } from "./config"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { userRouter } from "./routes/user"
import { couchdbRouter } from "./routes/couchdb"
import { instance } from "./bots"
import { storage } from "./storage"

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
app.route("/api/couchdb", couchdbRouter)

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


// BotKit ActivityPub 端点
app.all("*", async (c) => instance.fetch(c.req.raw))

export { app }
