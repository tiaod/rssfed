import { describe, it, expect, vi, afterEach } from 'vitest'
import { useOffline } from '../../composables/useOffline'
import { withSetup } from '../../utils/test-utils'

describe('useOffline', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('默认 isOnline 为 true', () => {
    const { result } = withSetup(() => useOffline())
    expect(result.isOnline.value).toBe(true)
    expect(result.isOffline.value).toBe(false)
  })

  it('监听 online/offline 事件', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const { result } = withSetup(() => useOffline())

    // onMounted 时注册了监听
    expect(addEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(addEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function))
  })

  it('触发 offline 事件后 isOnline 变为 false', () => {
    const { result } = withSetup(() => useOffline())

    window.dispatchEvent(new Event('offline'))
    expect(result.isOnline.value).toBe(false)
    expect(result.isOffline.value).toBe(true)
  })

  it('恢复 online 事件后 isOnline 回到 true', () => {
    const { result } = withSetup(() => useOffline())

    window.dispatchEvent(new Event('offline'))
    expect(result.isOnline.value).toBe(false)

    window.dispatchEvent(new Event('online'))
    expect(result.isOnline.value).toBe(true)
  })
})
