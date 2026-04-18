import { defineStore } from 'pinia'
import { authClient } from '~/lib/auth-client'

export const useUserStore = defineStore('user', () => {
  const session = authClient.useSession()

  const user = computed(() => session.value.data?.user ?? null)
  const isAuthenticated = computed(() => session.value.data?.user != null)
  const isPending = computed(() => session.value.isPending)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function refresh() {
    await authClient.getSession({
      fetchOptions: {
        onSuccess: (ctx) => {
          if (authClient.$store?.atoms?.session) {
            authClient.$store.atoms.session.set({
              ...authClient.$store.atoms.session.get(),
              data: ctx.data,
              isPending: false,
              isRefetching: false
            })
          }
        }
      }
    })
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
