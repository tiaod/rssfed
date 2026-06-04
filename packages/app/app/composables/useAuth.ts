import { createAuthClient } from "better-auth/vue"

let _client: ReturnType<typeof createAuthClient> | null = null

/**
 * 获取 better-auth 客户端实例（懒初始化，URL 来自 runtimeConfig）
 */
export function useAuthClient() {
  if (!_client) {
    const { public: { authBaseUrl } } = useRuntimeConfig()
    _client = createAuthClient({ baseURL: authBaseUrl })
  }
  return _client
}
