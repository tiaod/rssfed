import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Background Sync 的降级契约。
 *
 * 这套 API 只有 Chromium 有，且必须是安全上下文；Safari/iOS 与 Firefox 上
 * `registration.sync` 直接不存在。**「不支持」必须和「支持但被拒」表现一致**：
 * 都返回 false、都不抛、都不影响页面自己的 online 路径。这里锁定的就是这件事 ——
 * 一旦哪天错误冒泡到插件的初始化里，这些环境会连 Service Worker 注册都一起挂掉。
 *
 * 每个用例都重置模块：`initBackgroundSync` 与 networkState 的监听集合都是模块级单例，
 * 不重置的话第一个用例挂上之后，后面的用例全都在测「已经挂过了」。
 */

/** 把 navigator.serviceWorker 换成可控的桩（happy-dom 默认没有它） */
function stubServiceWorker(registration: unknown) {
  const addEventListener = vi.fn()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue(registration),
      addEventListener
    }
  })
  return { addEventListener }
}

/** 把 navigator.onLine 固定成某个值（isBrowserOffline 只在明确 false 时算离线） */
function stubOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online })
}

async function loadBackgroundSync() {
  return import('~/utils/backgroundSync')
}

describe('armBackgroundSync', () => {
  beforeEach(() => {
    vi.resetModules()
    stubOnline(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // 还原成 happy-dom 的默认形状：没有 serviceWorker / onLine 字段
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(navigator, 'onLine')
  })

  it('支持时登记固定的 tag', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    const { armBackgroundSync, BACKGROUND_SYNC_TAG } = await loadBackgroundSync()

    await expect(armBackgroundSync()).resolves.toBe(true)
    expect(register).toHaveBeenCalledWith(BACKGROUND_SYNC_TAG)
  })

  it('浏览器没有 sync（Safari / Firefox）→ 返回 false，不抛', async () => {
    stubServiceWorker({})
    const { armBackgroundSync } = await loadBackgroundSync()

    await expect(armBackgroundSync()).resolves.toBe(false)
  })

  it('还没有注册过 SW → 返回 false', async () => {
    stubServiceWorker(undefined)
    const { armBackgroundSync } = await loadBackgroundSync()

    await expect(armBackgroundSync()).resolves.toBe(false)
  })

  it('根本没有 serviceWorker（老浏览器 / 非安全上下文）→ 返回 false', async () => {
    const { armBackgroundSync } = await loadBackgroundSync()

    await expect(armBackgroundSync()).resolves.toBe(false)
  })

  it('登记被拒（隐私模式、用户关了后台同步）→ 返回 false 而不是抛出', async () => {
    stubServiceWorker({ sync: { register: vi.fn().mockRejectedValue(new Error('denied')) } })
    const { armBackgroundSync } = await loadBackgroundSync()

    await expect(armBackgroundSync()).resolves.toBe(false)
  })
})

describe('armBackgroundSyncIfOffline', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(navigator, 'onLine')
  })

  it('联网时不登记：否则每进一次页面就白唤醒一次 SW', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    stubOnline(true)
    const { armBackgroundSyncIfOffline } = await loadBackgroundSync()

    await expect(armBackgroundSyncIfOffline()).resolves.toBe(false)
    expect(register).not.toHaveBeenCalled()
  })

  it('断网时登记', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    stubOnline(false)
    const { armBackgroundSyncIfOffline, BACKGROUND_SYNC_TAG } = await loadBackgroundSync()

    await expect(armBackgroundSyncIfOffline()).resolves.toBe(true)
    expect(register).toHaveBeenCalledWith(BACKGROUND_SYNC_TAG)
  })
})

describe('initBackgroundSync', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(navigator, 'onLine')
  })

  it('进页面时已经断网也要登记（设备早就断了，不会有 offline 事件可听）', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    stubOnline(false)
    const { initBackgroundSync, BACKGROUND_SYNC_TAG } = await loadBackgroundSync()

    initBackgroundSync()
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith(BACKGROUND_SYNC_TAG))
  })

  it('联网进页面时不登记', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    stubOnline(true)
    const { initBackgroundSync } = await loadBackgroundSync()

    initBackgroundSync()
    // 登记是异步的：给它一个回合的机会，没登记就是没登记
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(register).not.toHaveBeenCalled()
  })

  it('断网事件触发登记', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    stubServiceWorker({ sync: { register } })
    stubOnline(true)
    const { initBackgroundSync, BACKGROUND_SYNC_TAG } = await loadBackgroundSync()

    initBackgroundSync()
    stubOnline(false)
    window.dispatchEvent(new Event('offline'))

    await vi.waitFor(() => expect(register).toHaveBeenCalledWith(BACKGROUND_SYNC_TAG))
  })
})

describe('SW 消息', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('收到 BACKGROUND_SYNC_DONE 时走「恢复联网」的同一条路径', async () => {
    const { addEventListener } = stubServiceWorker({})
    const { BACKGROUND_SYNC_DONE, initBackgroundSync } = await loadBackgroundSync()
    const { onBrowserOnline } = await import('~/utils/networkState')

    const recovered = vi.fn()
    onBrowserOnline(recovered)
    initBackgroundSync()

    // 找 initBackgroundSync 挂的那个 message 监听（happy-dom 的 addEventListener 是桩）
    const handler = addEventListener.mock.calls.find(([type]) => type === 'message')?.[1] as
      | ((event: { data?: unknown }) => void)
      | undefined
    expect(handler).toBeTypeOf('function')

    // 同一个通道还在传 SKIP_WAITING 之类，不能一并当成「同步完了」
    handler!({ data: { type: 'SKIP_WAITING' } })
    expect(recovered).not.toHaveBeenCalled()

    handler!({ data: { type: BACKGROUND_SYNC_DONE } })
    expect(recovered).toHaveBeenCalledTimes(1)
  })
})
