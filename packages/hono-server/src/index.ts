import 'dotenv/config'
import { serve } from "@hono/node-server"
import { randomUUID } from "node:crypto"
import { app } from "./app"
import {
  couchUrl,
  couchUser,
  couchPass,
  setProxySecret,
  ensureSystemDatabases,
} from "./couchdb/client"
import { shutdownWorkers } from "./workers"
import { shutdownBots } from "./bots"

const port = parseInt(process.env.PORT ?? "3001")

// ── 启动时配置 CouchDB Proxy Authentication ──

async function configureProxyAuth() {
  const base = couchUrl.replace(/\/+$/, "")
  const secret = process.env.COUCHDB_PROXY_SECRET || randomUUID()

  // 写入共享变量，供代理路由使用
  setProxySecret(secret)

  // CouchDB 配置 API 需要管理员凭证
  const basic = Buffer.from(`${couchUser}:${couchPass}`).toString("base64")

  const configs: Record<string, string> = {
    "chttpd_auth/proxy_use_secret": "true",
    "chttpd_auth/secret": secret,
    // 启用 proxy 认证 handler；term 格式：逗号分隔、不带方括号
    "chttpd/authentication_handlers": "{chttpd_auth, cookie_authentication_handler}, {chttpd_auth, proxy_authentication_handler}, {chttpd_auth, default_authentication_handler}",
  }

  for (const [key, value] of Object.entries(configs)) {
    await setCouchConfig(base, basic, key, value)
  }

  // 确保 _users 系统库存在（消除监听器报错噪音）
  await ensureSystemDatabases()
  console.log("[CouchDB Config] proxy auth configured")
}

/** 设置单条 CouchDB 配置：优先节点级 API，失败时回退到全局 API */
async function setCouchConfig(base: string, basic: string, key: string, value: string) {
  const nodeEndpoint = `${base}/_node/_local/_config/${key}`
  if (await putCouchConfig(nodeEndpoint, basic, value)) return

  const fallbackEndpoint = `${base}/_config/${key}`
  if (!(await putCouchConfig(fallbackEndpoint, basic, value))) {
    console.warn(`[CouchDB Config] Failed to set ${key}`)
  }
}

/** PUT 配置值到 CouchDB；请求抛出网络异常时返回 false（不校验 HTTP 状态码，与原有行为一致） */
async function putCouchConfig(endpoint: string, basic: string, value: string): Promise<boolean> {
  try {
    await fetch(endpoint, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify(value),
    })
    return true
  } catch {
    return false
  }
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
