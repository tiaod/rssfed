import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '../../stores/user'

describe('useUserStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态用户为 null', () => {
    const store = useUserStore()
    expect(store.user).toBeNull()
    expect(store.isAuthenticated).toBe(false)
    expect(store.isPending).toBe(false)
  })

  it('logout 调用 signOut', async () => {
    const store = useUserStore()
    const { authClient } = await import('~/lib/auth-client')

    await store.logout()

    expect(authClient.signOut).toHaveBeenCalledOnce()
  })
})
