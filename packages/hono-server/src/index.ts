import 'dotenv/config'
import { serve } from "@hono/node-server"
import { randomUUID } from "node:crypto"
import { app } from "./app"
import { couchUrl, setProxySecret } from "./couchdb/client"
import { shutdownWorkers } from "./workers"
import { shutdownBots } from "./bots"

const port = parseInt(process.env.PORT ?? "3001")

// ── 启动时配置 CouchDB Proxy Authentication ──

async function configureProxyAuth() {
  const base = couchUrl.replace(/\/+$/, "")
  const secret = process.env.COUCHDB_PROXY_SECRET || randomUUID()

  // 写入共享变量，供代理路由使用
  setProxySecret(secret)

  const configs: Record<string, string> = {
    "chttpd_auth/proxy_use_secret": "true",
    "chttpd_auth/secret": secret,
  }

  for (const [key, value] of Object.entries(configs)) {
    try {
      await fetch(`${base}/_node/_local/_config/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      })
    } catch {
      try {
        await fetch(`${base}/_config/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        })
      } catch {
        console.warn(`[CouchDB Config] Failed to set ${key}`)
      }
    }
  }
  console.log("[CouchDB Config] proxy_use_secret enabled")
}

// ── 启动 ──

const server = serve({ fetch: app.fetch, port })

configureProxyAuth().then(() => {
  console.log("CouchDB proxy auth ready")
}).catch((err) => {
  console.error("Failed to configure CouchDB proxy auth:", err)
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
