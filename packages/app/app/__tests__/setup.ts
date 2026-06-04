import { vi } from 'vitest'

// Mock better-auth/vue client — 避免在测试中触发真实 HTTP 请求
vi.mock('~/lib/auth-client', () => ({
  authClient: {
    useSession: vi.fn(() => ({
      value: {
        data: null,
        isPending: false,
      },
    })),
    getSession: vi.fn(),
    signOut: vi.fn(),
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
  },
}))
