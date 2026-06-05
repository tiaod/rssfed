import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { allowedOrigins } from "./config"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { syncRouter } from "./routes/sync"
import { subscriptionsRouter } from "./routes/subscriptions"
import { fediMiddleware } from "./bots"

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
app.route("/api/sync", syncRouter)
app.route("/api/subscriptions", subscriptionsRouter)

app.get("/api/health", (c) => c.json({ status: "ok" }))

app.use("/", fediMiddleware)

export { app }
