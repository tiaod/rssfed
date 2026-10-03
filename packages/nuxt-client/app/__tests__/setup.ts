import { ref } from 'vue'
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
// Nuxt 的 useState：测试里退化成普通 ref，只需要支持初始值
nuxtGlobals.useState = vi.fn(<T>(_key: string, init: () => T) => ref(init()))
nuxtGlobals.navigateTo = vi.fn()
// Nuxt 的 useRoute / useRouter：组件只读 params（如「地址里是否带着条目」），默认给一份空参数表。
// 注意 EntryDetailModal 读的是 router.currentRoute 而不是 useRoute：Nuxt 的 _route 慢一拍
// （见组件里的注释），测试桩要跟着给同一份形状
const emptyRouteParams = () => ({ params: {} as Record<string, string> })
nuxtGlobals.useRoute = vi.fn(emptyRouteParams)
nuxtGlobals.useRouter = vi.fn(() => ({ currentRoute: { value: emptyRouteParams() } }))
// runtimeConfig 供 useCouchTargets 等 composable 读取后端地址
nuxtGlobals.useRuntimeConfig = () => ({
  public: {
    apiBaseUrl: 'http://localhost:3001',
    authBaseUrl: 'http://localhost:3001/api/auth'
  }
})
