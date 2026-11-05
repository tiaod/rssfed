import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '../../stores/user'
import { SESSION_SNAPSHOT_KEY } from '../../utils/sessionSnapshot'

interface MockAuthClient {
  useSession: ReturnType<typeof vi.fn>
  getSession: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
}

function authClient(): MockAuthClient {
  return (globalThis as unknown as { useAuthClient: () => MockAuthClient }).useAuthClient()
}

describe('useUserStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    const client = authClient()
    vi.clearAllMocks()
    // 默认：请求成功、明确没有会话
    client.useSession.mockReturnValue({ value: { data: null, isPending: false } })
    client.getSession.mockResolvedValue({ data: null })
    client.signOut.mockResolvedValue(undefined)
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

  it('会话请求失败（离线）时回退本地快照', () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ id: 'u1', name: 'Alice', role: 'admin' }))
    authClient().useSession.mockReturnValue({
      value: { data: null, isPending: false, error: new Error('offline') }
    })

    const store = useUserStore()

    expect(store.user?.name).toBe('Alice')
    expect(store.isAuthenticated).toBe(true)
  })

  it('首帧（isPending）不读本地快照，保持与 SSR 一致', () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ id: 'u1', name: 'Alice' }))
    authClient().useSession.mockReturnValue({ value: { data: null, isPending: true } })

    const store = useUserStore()

    expect(store.user).toBeNull()
  })

  it('服务端明确返回未登录时清掉本地快照', async () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ id: 'u1', name: 'Alice' }))
    const store = useUserStore()

    await store.refresh()

    expect(localStorage.getItem(SESSION_SNAPSHOT_KEY)).toBeNull()
  })

  it('logout 清掉本地快照', async () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ id: 'u1', name: 'Alice' }))
    const store = useUserStore()

    await store.logout()

    expect(localStorage.getItem(SESSION_SNAPSHOT_KEY)).toBeNull()
  })

  it('离线登出（signOut 失败）不抛错，且本地快照仍被清掉', async () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ id: 'u1', name: 'Alice' }))
    authClient().signOut.mockRejectedValueOnce(new Error('offline'))
    const store = useUserStore()

    await expect(store.logout()).resolves.toBeUndefined()
    expect(localStorage.getItem(SESSION_SNAPSHOT_KEY)).toBeNull()
  })
})
