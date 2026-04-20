import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from '../[...all]'

// Mock auth
vi.mock('~/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue({
        user: {
          miniflux: {
            minifluxApiKey: 'test-api-key'
          }
        }
      })
    }
  }
}))

// Mock proxyRequest
const mockProxy = vi.fn().mockResolvedValue({ status: 200 })
vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    proxyRequest: mockProxy
  }
})

// Mock environment variables
process.env.MINIFLUX_BASE_URL = 'https://miniflux.example.com'

// Helper to create mock event
const createMockEvent = (path: string): H3Event => {
  const url = new URL(path, 'http://localhost:3000')
  return {
    node: { req: { headers: {} } },
    path: url.pathname,
    headers: new Headers()
  } as unknown as H3Event
}

describe('Miniflux Proxy', () => {
  beforeEach(() => {
    mockProxy.mockClear()
    vi.mocked(require('~/lib/auth').auth.api.getSession).mockResolvedValue({
      user: {
        miniflux: {
          minifluxApiKey: 'test-api-key'
        }
      }
    })
  })

  it('should proxy normal path correctly', async () => {
    const event = createMockEvent('/api/miniflux/entries?limit=10')

    await handler(event)

    expect(mockProxy).toHaveBeenCalledWith(
      event,
      'https://miniflux.example.com/v1/entries?limit=10',
      expect.anything()
    )
  })

  it('should block path traversal attack with ..', async () => {
    const event = createMockEvent('/api/miniflux/../../etc/passwd')

    await expect(handler(event)).rejects.toThrow('无效的请求路径')

  })

  it('should block URL encoded path traversal attack', async () => {
    const event = createMockEvent('/api/miniflux/%2e%2e/%2e%2e/etc/passwd') // %2e%2e is encoded ..

    await expect(handler(event)).rejects.toThrow('无效的请求路径')
  })

  it('should block relative path traversal', async () => {
    const event = createMockEvent('/api/miniflux/../admin')

    await expect(handler(event)).rejects.toThrow('无效的请求路径')
  })

  it('should handle path with . correctly', async () => {
    const event = createMockEvent('/api/miniflux/./v1/entries')

    await handler(event)

    expect(mockProxy).toHaveBeenCalledWith(
      event,
      'https://miniflux.example.com/v1/v1/entries',
      expect.anything()
    )
  })

  it('should return 401 when user is not logged in', async () => {
    // Mock empty session
    vi.mocked(require('~/lib/auth').auth.api.getSession).mockResolvedValueOnce(null)

    const event = createMockEvent('/api/miniflux/entries')

    await expect(handler(event)).rejects.toThrow('未登录或Miniflux账号未初始化')
  })

  it('should return 401 when miniflux api key is not set', async () => {
    // Mock session without miniflux key
    vi.mocked(require('~/lib/auth').auth.api.getSession).mockResolvedValueOnce({
      user: {}
    })

    const event = createMockEvent('/api/miniflux/entries')

    await expect(handler(event)).rejects.toThrow('未登录或Miniflux账号未初始化')
  })

  it('should not follow redirects (SSRF protection)', async () => {
    const event = createMockEvent('/api/miniflux/entries')

    await handler(event)

    expect(mockProxy).toHaveBeenCalledWith(
      event,
      expect.any(String),
      expect.objectContaining({
        fetchOptions: expect.objectContaining({
          redirect: 'manual'
        })
      })
    )
  })

  it('should inject X-Auth-Token header correctly', async () => {
    const event = createMockEvent('/api/miniflux/entries')

    await handler(event)

    expect(mockProxy).toHaveBeenCalledWith(
      event,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Auth-Token': 'test-api-key'
        })
      })
    )
  })
})

