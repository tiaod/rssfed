import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

describe('app error middleware pattern', () => {
  it('should handle HTTPException with correct status', async () => {
    const app = new Hono()
      .onError((err, c) => {
        if (err instanceof HTTPException) {
          return c.json({ error: { code: err.status, message: err.message } }, err.status)
        }
        return c.json({ error: { code: 500, message: 'Internal Server Error' } }, 500)
      })
      .get('/test-error', () => {
        throw new HTTPException(403, { message: 'Forbidden' })
      })

    const res = await app.request('/test-error')
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.code).toBe(403)
    expect(body.error.message).toBe('Forbidden')
  })

  it('should handle unknown errors with 500', async () => {
    const app = new Hono()
      .onError((err, c) => {
        if (err instanceof HTTPException) {
          return c.json({ error: { code: err.status, message: err.message } }, err.status)
        }
        console.error('[api-error]', err)
        return c.json({ error: { code: 500, message: 'Internal Server Error' } }, 500)
      })
      .get('/crash', () => {
        throw new Error('Unexpected error')
      })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/crash')
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe(500)
    expect(body.error.message).toBe('Internal Server Error')
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should route to mounted sub-routes', async () => {
    const nested = new Hono()
      .get('/hello', c => c.json({ message: 'world' }))

    const app = new Hono()
      .route('/api/test', nested)

    const res = await app.request('/api/test/hello')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.message).toBe('world')
  })
})
