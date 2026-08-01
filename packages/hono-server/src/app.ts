import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { allowedOrigins } from "./config"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { couchdbRouter } from "./routes/couchdb"
import { instance } from "./bots"

const app = new Hono()

app.use("/api/*", cors({
  origin: allowedOrigins,
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
