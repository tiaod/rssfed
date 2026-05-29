import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import route from '../miniflux'

const mockRequireAuth = vi.hoisted(() => vi.fn())
const mockCreateMinifluxAccount = vi.hoisted(() => vi.fn())
const mockQueryFindFirst = vi.hoisted(() => vi.fn())

vi.mock('../_auth', () => ({
  requireAuth: mockRequireAuth
}))

vi.mock('~server/lib/db', () => ({
  db: {
    query: {
      minifluxAccount: {
        findFirst: mockQueryFindFirst
      }
    }
  }
}))

vi.mock('~/lib/miniflux/service', () => ({
  MinifluxServiceError: class MinifluxServiceError extends Error {},
  minifluxAccountService: {
    createMinifluxAccount: mockCreateMinifluxAccount
  }
}))

describe('GET /account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MINIFLUX_BASE_URL = 'https://miniflux.example.com'
  })

  it('should return 401 when not logged in', async () => {
    mockRequireAuth.mockImplementation(() => {
      throw new HTTPException(401, { message: '未登录' })
    })

    const res = await route.request('/account')

    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).toBe('未登录')
  })

  it('should return existing account', async () => {
    mockRequireAuth.mockReturnValue({ id: 'user-1', email: 'test@example.com' })
    mockQueryFindFirst.mockResolvedValue({
      minifluxUserId: 123,
      minifluxUsername: 'testuser'
    })

    const res = await route.request('/account')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toEqual({
      minifluxUserId: 123,
      username: 'testuser'
    })
  })

  it('should auto-create account when not found', async () => {
    mockRequireAuth.mockReturnValue({ id: 'user-2', email: 'new@example.com' })
    let callCount = 0
    mockQueryFindFirst.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(null)
      return Promise.resolve({
        minifluxUserId: 456,
        minifluxUsername: 'newuser'
      })
    })

    const res = await route.request('/account')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.minifluxUserId).toBe(456)
    expect(mockCreateMinifluxAccount).toHaveBeenCalledWith('user-2', 'new@example.com')
  })
})

describe('Miniflux proxy (/*)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MINIFLUX_BASE_URL = 'https://miniflux.example.com'
  })

  it('should return 401 when no api key', async () => {
    mockRequireAuth.mockReturnValue({ id: 'user-1', miniflux: null })

    const res = await route.request('/feeds')

    expect(res.status).toBe(401)
  })

  it('should return 401 when no session', async () => {
    mockRequireAuth.mockImplementation(() => {
      throw new HTTPException(401, { message: '未登录' })
    })

    const res = await route.request('/feeds')

    expect(res.status).toBe(401)
  })
})
