import { createAuthClient } from 'better-auth/vue'
import { resolveApiBase } from '~/utils/apiBase'

let _client: ReturnType<typeof createAuthClient> | null = null

/**
 * 获取 better-auth 客户端实例（懒初始化，URL 来自 runtimeConfig，
 * 局域网访问时动态替换 host 为页面访问地址）
 */
export function useAuthClient() {
  if (!_client) {
    const { public: { authBaseUrl } } = useRuntimeConfig()
    _client = createAuthClient({ baseURL: resolveApiBase(authBaseUrl) })
  }
  return _client
}
