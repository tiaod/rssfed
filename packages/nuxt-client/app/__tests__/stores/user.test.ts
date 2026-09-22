import { describe, it, expect, beforeEach } from 'vitest'
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
    // useAuthClient() 在 setup.ts 中已 mock，返回 mockAuthClient
    const mockAuthClient = (globalThis as unknown as {
      useAuthClient: () => { signOut: () => Promise<void> }
    }).useAuthClient()

    await store.logout()

    expect(mockAuthClient.signOut).toHaveBeenCalledOnce()
  })
})
