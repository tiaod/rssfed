import { vi } from 'vitest'

const g = globalThis as unknown as Record<string, unknown>

g.defineEventHandler = vi.fn(handler => handler)
g.readBody = vi.fn(event => event.readBody())
g.createError = vi.fn(options => options)
