import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { isOriginAllowed } from "./config"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { couchdbRouter } from "./routes/couchdb"
import { instance } from "./bots"

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
app.route("/api/couchdb", couchdbRouter)

app.get("/api/health", (c) => c.json({ status: "ok" }))

// BotKit ActivityPub 端点
app.all("*", async (c) => instance.fetch(c.req.raw))

export { app }
