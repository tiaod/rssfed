import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { posix } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { db } from '~server/lib/db'
import { minifluxAccount } from '~/lib/schema/miniflux'
import { eq } from 'drizzle-orm'
import { minifluxAccountService, MinifluxServiceError } from '~/lib/miniflux/service'
import { requireAuth } from './_auth'

const app = new Hono()

app.get('/account', async (c) => {
  const user = requireAuth(c)

  try {
    const existing = await db.query.minifluxAccount.findFirst({
      columns: { minifluxUserId: true, minifluxUsername: true },
      where: eq(minifluxAccount.userId, user.id)
    })
    if (existing) {
      return c.json({ success: true, data: { minifluxUserId: existing.minifluxUserId, username: existing.minifluxUsername } })
    }

    await minifluxAccountService.createMinifluxAccount(user.id, user.email)
    const created = await db.query.minifluxAccount.findFirst({
      columns: { minifluxUserId: true, minifluxUsername: true },
      where: eq(minifluxAccount.userId, user.id)
    })
    return c.json({ success: true, data: { minifluxUserId: created!.minifluxUserId, username: created!.minifluxUsername } })
  } catch (error) {
    if (error instanceof MinifluxServiceError) {
      throw new HTTPException(502, { message: `Miniflux 服务错误: ${error.message}` })
    }
    if (error instanceof Error) {
      throw new HTTPException(500, { message: error.message })
    }
    throw new HTTPException(500, { message: '未知错误' })
  }
})

app.all('/*', async (c) => {
  const user = requireAuth(c)
  const apiKey = user.miniflux?.minifluxApiKey
  if (!apiKey) {
    throw new HTTPException(401, { message: '未登录或Miniflux账号未初始化' })
  }

  const url = new URL(c.req.url)
  let path = url.pathname.replace(/^\/api\/miniflux/, '')
  const decoded = decodeURIComponent(path)
  if (decoded.includes('..') || !decoded.startsWith('/')) {
    throw new HTTPException(400, { message: '无效的请求路径' })
  }
  path = posix.normalize(decoded)

  const targetUrl = `${process.env.MINIFLUX_BASE_URL!.replace(/\/$/, '')}/v1${path}${url.search}`

  // 用 node:http 做原始代理，避免 fetch 自动解压 gzip 后再重新压缩
  const target = new URL(targetUrl)
  const isHttps = target.protocol === 'https:'
  const proxyReq = (isHttps ? httpsRequest : httpRequest)({
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: c.req.method,
    headers: {
      ...Object.fromEntries(c.req.raw.headers.entries()),
      'X-Auth-Token': apiKey,
      'host': target.hostname
    }
  })

  // 先写入请求体（如果有），再结束请求——`.end()` 后请求才会真正发出
  const rawBody = c.req.raw.body
  if (rawBody) {
    const reader = rawBody.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        proxyReq.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  proxyReq.end()

  // 再等待 Miniflux 响应
  const proxyRes = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    proxyReq.on('response', resolve)
    proxyReq.on('error', reject)
  })
  const responseHeaders = new Headers()
  const hopByHop = new Set(['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'upgrade'])
  for (const [k, vs] of Object.entries(proxyRes.headers)) {
    if (!k || hopByHop.has(k.toLowerCase())) continue
    if (Array.isArray(vs)) vs.forEach(v => v != null && responseHeaders.append(k, v))
    else if (vs != null) responseHeaders.set(k, vs)
  }

  // proxyRes 是 Node Readable 流，转成 Web ReadableStream 返回
  const body = new ReadableStream({
    start(controller) {
      proxyRes.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      proxyRes.on('end', () => controller.close())
      proxyRes.on('error', err => controller.error(err))
    }
  })

  return new Response(body, {
    status: proxyRes.statusCode ?? 500,
    statusText: proxyRes.statusMessage,
    headers: responseHeaders
  })
})

export default app
