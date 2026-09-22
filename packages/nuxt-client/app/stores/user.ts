import { defineStore } from 'pinia'
import { computed } from 'vue'

export const useUserStore = defineStore('user', () => {
  const authClient = useAuthClient()
  const session = authClient.useSession()

  const user = computed(() => session.value.data?.user ?? null)
  const isAuthenticated = computed(() => session.value.data?.user != null)
  const isPending = computed(() => session.value.isPending)
  const isAdmin = computed(() => (user.value as { role?: string } | null)?.role === 'admin')

  async function refresh() {
    try {
      const { data } = await authClient.getSession()
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
