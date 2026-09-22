import type { SessionUser } from '~/types/auth'

/**
 * 服务端预取 better-auth 会话，写入 useState 供 store 读取。
 *
 * 背景：store 里的 authClient.useSession() 是纯客户端的 nanostore，
 * 服务端渲染时它永远是 null，而客户端首帧未必（Suspense 等待异步组件期间，
 * 会话请求可能已经返回），于是 UserMenu / profile 页出现 hydration mismatch：
 * 服务端渲染出占位 "U"，客户端却渲染真实用户名。
 *
 * 这里只在服务端预取，结果随 payload 下发、客户端 hydration 时同步恢复，两端首帧一致；
 * 客户端的实时会话仍然由 nanostore 的 useSession 负责。
 *
 * 注意不能用 authClient.useSession(useFetch)：useFetch 不会把 Cookie 转发到跨源地址
 * （前端 :3000 → 后端 :3001），服务端拿到的永远是空会话，必须像下面这样显式带上。
 */
export default defineNuxtPlugin(async () => {
  const sessionUser = useState<SessionUser | null>('auth-session-user', () => null)

  if (!import.meta.server) return

  const { public: { authBaseUrl } } = useRuntimeConfig()

  try {
    const data = await $fetch<{ user?: SessionUser } | null>(
      `${resolveApiBase(authBaseUrl)}/get-session`,
      {
        headers: useRequestHeaders(['cookie']),
        // 后端异常时别把 SSR 一起拖死
        timeout: 5000
      }
    )
    sessionUser.value = data?.user ?? null
  } catch {
    // 后端不可达：保持未登录状态即可，离线时页面仍能用本地数据渲染
    sessionUser.value = null
  }
})
