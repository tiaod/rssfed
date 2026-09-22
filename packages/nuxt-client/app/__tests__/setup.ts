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
      isPending: false
    }
  })),
  // store 的 refresh() 会解构 getSession() 的返回值，mock 必须返回对象而非 undefined
  getSession: vi.fn(async () => ({ data: null })),
  signOut: vi.fn(),
  signUp: {
    email: vi.fn()
  },
  signIn: {
    email: vi.fn()
  },
  $store: {
    atoms: {
      session: {
        get: vi.fn(() => ({
          data: null,
          isPending: false,
          isRefetching: false
        })),
        set: vi.fn()
      }
    }
  }
}

// 模拟 Nuxt auto-import：这些 composable 在运行时由 Nuxt 挂到全局，测试环境手动补上
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.useAuthClient = vi.fn(() => mockAuthClient)
nuxtGlobals.useFetch = vi.fn()
nuxtGlobals.navigateTo = vi.fn()
