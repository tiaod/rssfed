import { SESSION_CHECK_STATE_KEY, type SessionCheckState } from '~/utils/sessionState'

/** 未登录也能访问的公开页面：落地页、登录页、离线壳 */
const PUBLIC_PATHS = new Set(['/welcome', '/login', '/offline'])

/**
 * 全局鉴权：未登录访问应用页时送去介绍引导页，而不是只有登录表单的登录页。
 *
 * 两端各用各的判据：
 * - SSR 用 plugins/auth-session.ts 预取的结论。不能在这里调 `useSession(useFetch)`——
 *   那不会把 Cookie 转发到跨源后端，服务端拿到的永远是空会话（见插件注释）。
 * - 客户端用 store：它同时覆盖 nanostore 的实时会话、payload 镜像与本地快照。
 */
export default defineNuxtRouteMiddleware((to) => {
  // 公开页面直接放行：否则 /welcome 会被自己拦下形成重定向循环
  if (PUBLIC_PATHS.has(to.path)) return

  // 离线时放行：本地 PouchDB 里有条目与订阅，把人赶去登录页会让离线阅读彻底失效
  if (import.meta.client && !navigator.onLine) return

  if (import.meta.server) {
    const check = useState<SessionCheckState>(SESSION_CHECK_STATE_KEY, () => 'unknown')
    // 只有明确拿到「未登录」才跳；unknown 说明后端不可达，宁可放行
    if (check.value === 'anonymous') {
      return navigateTo({ path: '/welcome', query: { redirect: to.fullPath } })
    }
    return
  }

  const userStore = useUserStore()
  // 已登录（后端不可达时 user 可能来自本地快照）放行
  if (userStore.user) return
  // 会话还没有结论，或请求失败：不把状态未定的用户误送到落地页
  if (userStore.isPending || userStore.hasSessionError) return

  return navigateTo({ path: '/welcome', query: { redirect: to.fullPath } })
})
