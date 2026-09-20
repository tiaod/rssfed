import { vi } from 'vitest'

// =====================================================
// Mock better-auth client
// useAuthClient() 是 Nuxt auto-imported composable，
// 在 vitest 环境中需要手动定义。
// =====================================================

const mockAuthClient = {
  useSession: vi.fn(() => ({
    value: {
      data: null,
      isPending: false,
    },
  })),
  // store 的 refresh() 会解构 getSession() 的返回值，mock 必须返回对象而非 undefined
  getSession: vi.fn(async () => ({ data: null })),
  signOut: vi.fn(),
  signUp: {
    email: vi.fn(),
  },
  signIn: {
    email: vi.fn(),
  },
  $store: {
    atoms: {
      session: {
        get: vi.fn(() => ({
          data: null,
          isPending: false,
          isRefetching: false,
        })),
        set: vi.fn(),
      },
    },
  },
}

// 模拟 Nuxt auto-import
;(globalThis as any).useAuthClient = vi.fn(() => mockAuthClient)

// 模拟 useFetch（Nuxt auto-import）
;(globalThis as any).useFetch = vi.fn()

// 模拟 navigateTo（Nuxt auto-import）
;(globalThis as any).navigateTo = vi.fn()
