import 'dotenv/config'
import { serve } from "@hono/node-server"
import { app } from "./app"
import { ensureGlobalDatabase } from "./couchdb/client"
import { shutdownWorkers } from "./workers"
import { shutdownBots } from "./bots"

const port = parseInt(process.env.PORT ?? "3001")

const server = serve({ fetch: app.fetch, port })

ensureGlobalDatabase().then(() => {
  console.log("CouchDB Global DB ready")
}).catch((err) => {
  console.error("Failed to initialize CouchDB:", err)
})

console.log(`Server running on http://localhost:${port}`)

async function shutdown() {
  console.log("Shutting down gracefully...")
  server.close()
  await Promise.allSettled([shutdownWorkers(), shutdownBots()])
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
