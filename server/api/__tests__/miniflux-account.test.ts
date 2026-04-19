import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { User } from '~/lib/miniflux/types'
import type { Mock } from 'vitest'

const mockGetSession = vi.fn()
const mockSelect = vi.fn().mockReturnThis()
const mockFrom = vi.fn().mockReturnThis()
const mockWhere = vi.fn().mockReturnThis()
const mockLimit = vi.fn().mockResolvedValue([])
const mockInsert = vi.fn().mockReturnThis()
const mockValues = vi.fn().mockReturnThis()

let mockCreateUser: Mock
let mockCreateAPIKey: Mock

vi.mock('~/lib/auth', () => ({
  auth: {
    api: {
      getSession: mockGetSession
    }
  }
}))

vi.mock('~/lib/db', () => ({
  db: {
    select: mockSelect,
    from: mockFrom,
    where: mockWhere,
    limit: mockLimit,
    insert: mockInsert,
    values: mockValues
  }
}))

vi.mock('~/lib/miniflux/service', () => ({
  MinifluxAccountService: vi.fn(),
  MinifluxServiceError: function MinifluxServiceError(message: string): Error {
    const err = new Error(message)
    err.name = 'MinifluxServiceError'
    return err
  } as unknown as typeof import('~/lib/miniflux/service').MinifluxServiceError,
  minifluxAccountService: {}
}))

vi.mock('~/lib/miniflux/client', () => {
  mockCreateUser = vi.fn()
  mockCreateAPIKey = vi.fn()

  function MockMinifluxClient(this: {
    createUser: typeof mockCreateUser
    createAPIKey: typeof mockCreateAPIKey
  }) {
    this.createUser = mockCreateUser
    this.createAPIKey = mockCreateAPIKey
  }

  MockMinifluxClient.prototype.createUser = mockCreateUser
  MockMinifluxClient.prototype.createAPIKey = mockCreateAPIKey

  return {
    MinifluxClient: MockMinifluxClient as unknown as typeof import('~/lib/miniflux/client').MinifluxClient,
    MinifluxError: function MinifluxError(message: string, statusCode?: number, errorMessage?: string): Error {
      const err = new Error(message)
      err.name = 'MinifluxError'
      Object.defineProperty(err, 'statusCode', { value: statusCode })
      Object.defineProperty(err, 'errorMessage', { value: errorMessage })
      return err
    } as unknown as typeof import('~/lib/miniflux/client').MinifluxError
  }
})

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

  it('已登录用户应该返回现有账户信息', async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: 'user-123',
        email: 'test@example.com'
      }
    })

    const mockAccount = {
      minifluxUserId: 123,
      minifluxUsername: 'user_abc123',
      minifluxApiKey: 'test-api-key'
    }
    mockLimit.mockResolvedValue([mockAccount])

    mockSelect.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })

    const module = await import('../miniflux/account.get')
    const handler = module.default
    const result = await handler({
      headers: new Headers()
    } as unknown as H3Event)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      minifluxUserId: 123,
      username: 'user_abc123',
      apiKey: 'test-api-key',
      endpoint: process.env.MINIFLUX_BASE_URL
    })
  })

  it('自动创建账号当用户不存在', async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: 'user-123',
        email: 'test@example.com'
      }
    })

    mockLimit.mockResolvedValue([])
    mockSelect.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })

    mockCreateUser.mockResolvedValue({
      id: 456
    } as User)

    mockCreateAPIKey.mockResolvedValue({
      token: 'new-auto-created-key'
    })

    const module = await import('../miniflux/account.get')
    const handler = module.default
    const result = await handler({
      headers: new Headers()
    } as unknown as H3Event)

    expect(result.success).toBe(true)
    expect(result.data.minifluxUserId).toBe(456)
    expect(result.data.apiKey).toBe('new-auto-created-key')
    expect(mockCreateUser).toHaveBeenCalled()
    expect(mockCreateAPIKey).toHaveBeenCalled()
  })
})
