import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { feedsRouter } from "./routes/feeds"
import { botsRouter } from "./routes/bots"
import { syncRouter } from "./routes/sync"
import { subscriptionsRouter } from "./routes/subscriptions"
import { fediMiddleware } from "./bots"
import { ensureGlobalDatabase } from "./couchdb/client"

const app = new Hono()

app.use("/api/*", cors({
  origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
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

const port = parseInt(process.env.PORT ?? "3001")

ensureGlobalDatabase().then(() => {
  console.log("CouchDB Global DB ready")
  serve({ fetch: app.fetch, port })
  console.log(`Server running on http://localhost:${port}`)
}).catch((err) => {
  console.error("Failed to initialize CouchDB:", err)
  serve({ fetch: app.fetch, port })
  console.log(`Server running on http://localhost:${port} (CouchDB unavailable)`)
})