import { vi } from 'vitest'

globalThis.defineEventHandler = vi.fn((handler) => handler)
globalThis.readBody = vi.fn((event) => event.readBody())
globalThis.createError = vi.fn((options) => options)
