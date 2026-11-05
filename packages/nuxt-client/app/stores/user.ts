import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useCouchTargets } from '~/composables/useCouchTargets'
import { SESSION_USER_STATE_KEY } from '~/utils/sessionState'
import { clearSessionSnapshot, readSessionSnapshot, writeSessionSnapshot } from '~/utils/sessionSnapshot'
import { clearCachedSessionResponses } from '~/utils/serviceWorkerCache'
import type { SessionUser } from '~/types/auth'

export const useUserStore = defineStore('user', () => {
  const authClient = useAuthClient()
  const session = authClient.useSession()

  // SSR 阶段由 plugins/auth-session.ts 写入的会话，随 payload 下发并在客户端 hydration 时恢复。
  // 客户端首帧 nanostore 还是 isPending，用它让两端的首帧渲染结果一致，避免 hydration mismatch。
  const sessionUser = useState<SessionUser | null>(SESSION_USER_STATE_KEY, () => null)

  /**
   * 会话用户的本地快照（见 utils/sessionSnapshot）：服务端不可达时用来保留「已登录」
   * 的界面展示。SSR 没有 localStorage，此时为 null。
   */
  const snapshotUser = ref<SessionUser | null>(
    typeof window !== 'undefined' ? readSessionSnapshot() : null
  )

  // nanostore 一旦有结论（isPending 为 false）就以它为准：登录、登出、跨标签页同步都靠它实时更新；
  // 有结论之前（SSR 与客户端首帧）回退到 payload 里的会话。
  // 请求失败（离线 / 后端不可达）时再回退本地快照 —— 这条分支只在 hydration 之后出现，
  // 不会让客户端首帧与 SSR 输出不一致。
  const user = computed<SessionUser | null>(() => {
    const state = session.value
    if (state.isPending) return sessionUser.value
    if (state.error) return snapshotUser.value
    return (state.data?.user as SessionUser | undefined) ?? null
  })

  const isAuthenticated = computed(() => user.value != null)
  const isPending = computed(() => session.value.isPending)
  const isAdmin = computed(() => user.value?.role === 'admin')

  /** 会话结论明确后同步快照：登录写入；未登录（含服务端撤销会话）清除 */
  function applySessionUser(next: SessionUser | null) {
    snapshotUser.value = next
    if (next) writeSessionSnapshot(next)
    else clearSessionSnapshot()
  }

  if (typeof window !== 'undefined') {
    watch(
      () => session.value,
      (state) => {
        // 请求失败时保留快照（离线仍要显示已登录）；只有拿到明确结论才覆盖
        if (!state || state.isPending || state.error) return
        applySessionUser((state.data?.user as SessionUser | undefined) ?? null)
      },
      { deep: true }
    )
  }

  async function refresh() {
    try {
      const { data } = await authClient.getSession()
      const next = (data?.user as SessionUser | undefined) ?? null
      // 同步 SSR 会话镜像：登出（data 为 null）后不能继续回退到旧用户
      sessionUser.value = next
      applySessionUser(next)
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
      // 离线或后端不可达：保留现有用户状态（含本地快照）即可。
      // 不吞掉这个异常会在离线时冒成 unhandled rejection（页面本身仍能用本地数据渲染）
    }
  }

  async function logout() {
    try {
      await authClient.signOut()
    } catch {
      // 离线登出：服务端会话无法撤销（会话 cookie 是 HttpOnly，前端也删不掉），
      // 联网后若该会话仍有效会恢复登录。本地状态仍照常清空，离线期间按未登录展示。
    } finally {
      // 无论服务端是否可达，本地状态都必须立刻失效：
      // 1）payload 镜像与本地快照；2）按账号绑定的 CouchDB 库名
      sessionUser.value = null
      applySessionUser(null)
      // 代理寻址信息（CouchDB 库名）与账号绑定，登出后必须失效，
      // 否则同一浏览器换账号登录会继续用上一个账号的库名（同步只会拿到 403）
      useCouchTargets().invalidate()
      // Service Worker 缓存里的 get-session 响应也必须删掉，否则断网时会命中旧会话
      await clearCachedSessionResponses()
      await refresh()
    }
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
