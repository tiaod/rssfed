import { defineStore } from 'pinia'
import { computed } from 'vue'

export const useUserStore = defineStore('user', () => {
  const authClient = useAuthClient()
  const session = authClient.useSession()

  const user = computed(() => session.value.data?.user ?? null)
  const isAuthenticated = computed(() => session.value.data?.user != null)
  const isPending = computed(() => session.value.isPending)
  const isAdmin = computed(() => (user.value as any)?.role === 'admin')

  async function refresh() {
    const { data } = await authClient.getSession()
    // 手动更新 session 原子，确保 useSession() 的响应式 ref 随之更新
    if (data && authClient.$store?.atoms?.session) {
      authClient.$store.atoms.session.set({
        ...authClient.$store.atoms.session.get(),
        data,
        isPending: false,
        isRefetching: false,
      })
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
