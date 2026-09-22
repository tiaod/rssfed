import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useCouchTargets } from '~/composables/useCouchTargets'
import type { SessionUser } from '~/types/auth'

export const useUserStore = defineStore('user', () => {
  const authClient = useAuthClient()
  const session = authClient.useSession()

  // SSR 阶段由 plugins/auth-session.ts 写入的会话，随 payload 下发并在客户端 hydration 时恢复。
  // 客户端首帧 nanostore 还是 isPending，用它让两端的首帧渲染结果一致，避免 hydration mismatch。
  const sessionUser = useState<SessionUser | null>('auth-session-user', () => null)

  // nanostore 一旦有结论（isPending 为 false）就以它为准：登录、登出、跨标签页同步都靠它实时更新；
  // 有结论之前（SSR 与客户端首帧）回退到 payload 里的会话。
  const user = computed<SessionUser | null>(() => {
    if (!session.value.isPending) {
      return (session.value.data?.user as SessionUser | undefined) ?? null
    }
    return sessionUser.value
  })

  const isAuthenticated = computed(() => user.value != null)
  const isPending = computed(() => session.value.isPending)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function refresh() {
    try {
      const { data } = await authClient.getSession()
      // 同步 SSR 会话镜像：登出（data 为 null）后不能继续回退到旧用户
      sessionUser.value = (data?.user as SessionUser | undefined) ?? null
      // 手动更新 session 原子，确保 useSession() 的响应式 ref 随之更新
      if (data && authClient.$store?.atoms?.session) {
        authClient.$store.atoms.session.set({
          ...authClient.$store.atoms.session.get(),
          data,
          isPending: false,
          isRefetching: false
        })
      }
    } catch {
      // 离线或后端不可达：保留现有用户状态即可。
      // 不吞掉这个异常会在离线时冒成 unhandled rejection（页面本身仍能用本地数据渲染）
    }
  }

  async function logout() {
    await authClient.signOut()
    // 会话已经结束，清掉镜像，避免 isPending 期间 user 回退到刚登出的用户
    sessionUser.value = null
    // 代理寻址信息（CouchDB 库名）与账号绑定，登出后必须失效，
    // 否则同一浏览器换账号登录会继续用上一个账号的库名（同步只会拿到 403）
    useCouchTargets().invalidate()
    await refresh()
  }

  return {
    user,
    isAuthenticated,
    isPending,
    isAdmin,
    refresh,
    logout
  }
})
