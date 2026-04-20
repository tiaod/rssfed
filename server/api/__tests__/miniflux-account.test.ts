import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

const mockGetSession = vi.fn()
const mockQueryFindFirst = vi.fn().mockResolvedValue(null)

const mockCreateMinifluxAccount = vi.fn().mockResolvedValue(undefined)

vi.mock('~/lib/auth', () => ({
  auth: {
    api: {
      getSession: mockGetSession
    }
  }
}))

vi.mock('~/lib/db', () => ({
  db: {
    query: {
      minifluxAccount: {
        findFirst: mockQueryFindFirst
      }
    }
  }
}))

vi.mock('~/lib/miniflux/service', () => ({
  MinifluxServiceError: function MinifluxServiceError(message: string): Error {
    const err = new Error(message)
    err.name = 'MinifluxServiceError'
    return err
  } as unknown as typeof import('~/lib/miniflux/service').MinifluxServiceError,
  minifluxAccountService: {
    createMinifluxAccount: mockCreateMinifluxAccount
  }
}))

vi.mock('#imports', () => ({
  defineEventHandler: (handler: unknown) => handler,
  createError: (options: { statusCode: number, message: string }) => {
    const err = new Error(options.message)
    Object.assign(err, options)
    throw err
  }
}))

describe('GET /api/miniflux/account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未登录用户应该返回 401 错误', async () => {
    mockGetSession.mockResolvedValue(null)

    const module = await import('../miniflux/account.get')
    const handler = module.default

    try {
      await handler({
        headers: new Headers()
      } as unknown as H3Event)
      expect.fail('应该抛出错误')
    } catch (error) {
      const err = error as { statusCode: number, message: string }
      expect(err.statusCode).toBe(401)
      expect(err.message).toBe('未登录')
    }
  })

  it('session 存在但 user 不存在应该返回 401 错误', async () => {
    mockGetSession.mockResolvedValue({
      user: undefined
    })

    const module = await import('../miniflux/account.get')
    const handler = module.default

    try {
      await handler({
        headers: new Headers()
      } as unknown as H3Event)
      expect.fail('应该抛出错误')
    } catch (error) {
      const err = error as { statusCode: number, message: string }
      expect(err.statusCode).toBe(401)
      expect(err.message).toBe('未登录')
    }
  })

  it('已登录用户应该返回现有账户信息（包含 apiKey）', async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: 'user-123',
        email: 'test@example.com'
      }
    })

    mockQueryFindFirst.mockResolvedValue({
      minifluxUserId: 123,
      minifluxUsername: 'user_abc123'
    })

    const module = await import('../miniflux/account.get')
    const handler = module.default
    const result = await handler({
      headers: new Headers()
    } as unknown as H3Event)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      minifluxUserId: 123,
      username: 'user_abc123'
    })
  })

  it('自动创建账号当用户不存在', async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: 'user-123',
        email: 'test@example.com'
      }
    })

    let callCount = 0
    mockQueryFindFirst.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(null)
      }
      return Promise.resolve({
        minifluxUserId: 456,
        minifluxUsername: 'test_abc123'
      })
    })

    const module = await import('../miniflux/account.get')
    const handler = module.default
    const result = await handler({
      headers: new Headers()
    } as unknown as H3Event)

    expect(result.success).toBe(true)
    expect(result.data.minifluxUserId).toBe(456)
    expect(result.data.username).toBe('test_abc123')
    expect(mockCreateMinifluxAccount).toHaveBeenCalledWith('user-123', 'test@example.com')
  })
})
