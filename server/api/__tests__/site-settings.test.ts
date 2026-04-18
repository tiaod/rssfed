import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { siteSettings } from '~/lib/schema/site-settings'

type SiteSettings = typeof siteSettings.$inferSelect

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  returning: vi.fn().mockReturnThis()
}

vi.mock('~/lib/db', () => ({
  db: mockDb
}))

vi.mock('#imports', () => ({
  defineEventHandler: (handler: unknown) => handler,
  readBody: (event: { readBody: () => unknown }) => event.readBody(),
  createError: (options: unknown) => options
}))

describe('GET /api/site-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应该返回站点设置当记录存在', async () => {
    const mockSettings: Partial<SiteSettings> = {
      id: 'main',
      siteName: '测试网站',
      siteDescription: '测试描述',
      seoTitle: null,
      seoDescription: null,
      seoKeywords: null,
      logoUrl: null,
      faviconUrl: null,
      primaryColor: null,
      secondaryColor: null,
      footerText: null,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    mockDb.limit.mockResolvedValue([mockSettings])

    const module = await import('../site-settings.get')
    const handler = module.default
    const result = await handler({} as H3Event)

    expect(result.settings).toEqual(mockSettings)
    expect(mockDb.select).toHaveBeenCalled()
  })

  it('应该返回 null 当记录不存在', async () => {
    mockDb.limit.mockResolvedValue([])

    const module = await import('../site-settings.get')
    const handler = module.default
    const result = await handler({} as H3Event)

    expect(result.settings).toBeNull()
    expect(mockDb.select).toHaveBeenCalled()
  })
})

describe('PUT /api/site-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('管理员应该能成功更新站点设置', async () => {
    const mockBody = {
      siteName: '新网站名称',
      siteDescription: '新描述',
      seoTitle: null,
      seoDescription: null,
      seoKeywords: null,
      logoUrl: null,
      faviconUrl: null,
      primaryColor: null,
      secondaryColor: null,
      footerText: null
    }
    const mockResult = [{
      id: 'main',
      ...mockBody,
      createdAt: new Date(),
      updatedAt: new Date()
    }]

    mockDb.returning.mockResolvedValue(mockResult)

    const module = await import('../site-settings.put')
    const handler = module.default
    const result = await handler({
      context: {
        user: { role: 'admin' }
      },
      readBody: () => Promise.resolve(mockBody)
    } as unknown as H3Event)

    expect(result.success).toBe(true)
    expect(result.settings).toEqual(mockResult[0])
    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('非管理员应该返回 403 错误', async () => {
    const module = await import('../site-settings.put')
    const handler = module.default

    try {
      await handler({
        context: {
          user: { role: 'user' }
        },
        readBody: () => Promise.resolve({})
      } as unknown as H3Event)
      expect.fail('应该抛出错误')
    } catch (error) {
      const err = error as { statusCode: number, statusMessage: string }
      expect(err.statusCode).toBe(403)
      expect(err.statusMessage).toBe('Forbidden')
    }
  })

  it('未登录用户应该返回 403 错误', async () => {
    const module = await import('../site-settings.put')
    const handler = module.default

    try {
      await handler({
        context: {
          user: null
        },
        readBody: () => Promise.resolve({})
      } as unknown as H3Event)
      expect.fail('应该抛出错误')
    } catch (error) {
      const err = error as { statusCode: number, statusMessage: string }
      expect(err.statusCode).toBe(403)
      expect(err.statusMessage).toBe('Forbidden')
    }
  })
})
