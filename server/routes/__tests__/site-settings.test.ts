import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import route from '../site-settings'

const mockRequireAdmin = vi.hoisted(() => vi.fn())

vi.mock('../_auth', () => ({
  requireAdmin: mockRequireAdmin
}))

vi.mock('~/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn()
    }
  }
}))

const mockLimit = vi.hoisted(() => vi.fn())
const mockReturning = vi.hoisted(() => vi.fn())
const mockWhere = vi.hoisted(() => vi.fn())
const mockOnConflictDoUpdate = vi.hoisted(() => vi.fn())
const mockValues = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('~server/lib/db', () => {
  mockLimit.mockReturnThis()
  mockWhere.mockReturnValue({ limit: mockLimit })
  mockFrom.mockReturnValue({ where: mockWhere })
  mockSelect.mockReturnValue({ from: mockFrom })
  mockValues.mockReturnThis()
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning })
  mockInsert.mockReturnValue({ values: mockValues, onConflictDoUpdate: mockOnConflictDoUpdate })

  return {
    db: {
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      limit: mockLimit,
      insert: mockInsert,
      values: mockValues,
      onConflictDoUpdate: mockOnConflictDoUpdate,
      returning: mockReturning
    }
  }
})

describe('GET /', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return settings when record exists', async () => {
    mockLimit.mockResolvedValue([{
      id: 'main',
      siteName: 'Test Site',
      siteDescription: 'Test Description'
    }])

    const res = await route.request('/')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.settings).toBeDefined()
    expect(body.settings.siteName).toBe('Test Site')
  })

  it('should return null when no record exists', async () => {
    mockLimit.mockResolvedValue([])

    const res = await route.request('/')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.settings).toBeNull()
  })
})

describe('PUT /', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin should update settings successfully', async () => {
    mockRequireAdmin.mockReturnValue({ role: 'admin', id: 'admin-1' })
    mockReturning.mockResolvedValue([{
      id: 'main',
      siteName: 'Updated Site',
      siteDescription: 'Updated Description',
      createdAt: new Date(),
      updatedAt: new Date()
    }])

    const res = await route.request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Updated Site', siteDescription: 'Updated Description' })
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.settings.siteName).toBe('Updated Site')
  })

  it('non-admin should get 403', async () => {
    mockRequireAdmin.mockImplementation(() => {
      throw new HTTPException(403, { message: 'Forbidden' })
    })

    const res = await route.request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'test' })
    })

    expect(res.status).toBe(403)
  })

  it('unauthenticated user should get 401', async () => {
    mockRequireAdmin.mockImplementation(() => {
      throw new HTTPException(401, { message: '未登录' })
    })

    const res = await route.request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'test' })
    })

    expect(res.status).toBe(401)
  })
})
