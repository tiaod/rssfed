import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { federation as fedifyMiddleware } from '@fedify/hono'
import { federation } from '../federation'
import { authMiddleware } from '../routes/_auth'
import authRoute from '../routes/auth'
import minifluxRoute from '../routes/miniflux'
import filesRoute from '../routes/files'
import siteSettingsRoute from '../routes/site-settings'

const app = new Hono()
  .use(logger())
  .use(fedifyMiddleware(federation, () => ({ userId: null })))
  .use(authMiddleware)
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: { code: err.status, message: err.message } }, err.status)
    }
    console.error('[api-error]', err)
    return c.json({ error: { code: 500, message: 'Internal Server Error' } }, 500)
  })
  .route('/api/auth', authRoute)
  .route('/api/miniflux', minifluxRoute)
  .route('/api/files', filesRoute)
  .route('/api/site-settings', siteSettingsRoute)

function toRequestFromIncoming(req: import('http').IncomingMessage): Request | Promise<Request> {
  const host = req.headers.host || 'localhost'
  const url = `http://${host}${req.url || '/'}`
  const method = req.method || 'GET'
  const headers = req.headers as Record<string, string>

  if (method !== 'GET' && method !== 'HEAD') {
    return new Promise<Request>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve(new Request(url, { method, headers, body: body.length > 0 ? body : undefined }))
      })
      req.on('error', reject)
    })
  }

  return new Request(url, { method, headers })
}

export default defineEventHandler(async (event) => {
  const req = (event as unknown as { req: import('http').IncomingMessage }).req
  const request = await toRequestFromIncoming(req)
  return app.fetch(request)
})
