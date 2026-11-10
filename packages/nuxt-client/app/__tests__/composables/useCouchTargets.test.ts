import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useRuntimeConfig 是 Nuxt auto-import，测试环境手动补上（见 app/__tests__/setup.ts 的同类处理）
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.useRuntimeConfig = () => ({ public: { apiBaseUrl: 'http://localhost:3001' } })

const BASE = 'http://localhost:3001'
const PROXY = `${BASE}/api/couchdb/proxy`

/** 记录的 targets 接口调用（用于验证缓存 / 退避 / 离线短路） */
let calls: string[] = []
let responseStatus = 200
let responseBody: Record<string, unknown> = {}

const realFetch = globalThis.fetch

/** 模拟浏览器离线：直接改 navigator.onLine（happy-dom 上可写） */
function setOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    value: online,
    configurable: true,
    writable: true
  })
}

function dispatchOnline() {
  globalThis.window?.dispatchEvent(new Event('online'))
}

beforeEach(() => {
  // 模块级缓存跨用例共享，重置模块以拿到干净状态
  vi.resetModules()
  calls = []
  responseStatus = 200
  responseBody = { timeline: 'user-timeline_aaa' }
  setOnline(true)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (responseStatus !== 200) return new Response('{}', { status: responseStatus })
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
})

async function loadComposable() {
  return await import('~/composables/useCouchTargets')
}

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  setOnline(true)
})

describe('useCouchTargets', () => {
  it('唯一的同步目标拼出带真实库名的代理地址', async () => {
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID))
      .resolves.toBe(`${PROXY}/${encodeURIComponent('user-timeline_aaa')}`)
    // 打的是只回一个库名的 /sync-targets（旧的 /targets 会为每个订阅源查一次库名）
    expect(calls).toEqual([`${BASE}/api/couchdb/sync-targets`])
  })

  it('业务 id（feed/bot）不再是同步目标：返回 null', async () => {
    const { useCouchTargets } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId('feed-1')).resolves.toBeNull()
    await expect(targets.remoteUrlForId('bot:42')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('多次取地址只打一次接口（缓存）', async () => {
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await targets.remoteUrlForId(TIMELINE_ID)
    await targets.remoteUrlForId(TIMELINE_ID)
    await targets.remoteUrlForId(TIMELINE_ID)
    expect(calls).toHaveLength(1)
  })

  it('invalidate 后重新拉取（订阅变更 / 库重建场景）', async () => {
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await targets.remoteUrlForId(TIMELINE_ID)
    targets.invalidate()
    responseBody = { timeline: 'user-timeline_ccc' }

    await expect(targets.remoteUrlForId(TIMELINE_ID))
      .resolves.toBe(`${PROXY}/${encodeURIComponent('user-timeline_ccc')}`)
    expect(calls).toHaveLength(2)
  })

  it('接口失败时抛错，不返回半成品缓存', async () => {
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow(/HTTP 500/)
  })

  it('响应缺少 timeline 时抛错（避免拿 undefined 拼地址）', async () => {
    responseBody = {}
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow(/timeline/)
  })
})

describe('失败退避（离线 sync-targets 请求风暴的根因）', () => {
  it('并发调用只发一次请求', async () => {
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    // 首屏里 getEntriesDb 会并发调到几十次：它们必须合并成同一个请求
    await Promise.all(Array.from({ length: 41 }, () => targets.remoteUrlForId(TIMELINE_ID)))
    expect(calls).toHaveLength(1)
  })

  it('失败后短时间内的再次调用不再发请求（失败也要记住）', async () => {
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    // 后面几十次调用都落在退避窗口内：一个请求都不该再发
    for (let i = 0; i < 40; i++) {
      await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    }
    expect(calls).toHaveLength(1)
  })

  it('退避窗口过去后重新尝试（不是永久熔断）', async () => {
    vi.useFakeTimers()
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    // 窗口内：仍然不发
    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    // 过了窗口、后端也恢复了：应当重新请求并成功
    responseStatus = 200
    vi.setSystemTime(Date.now() + 10_000)
    await expect(targets.remoteUrlForId(TIMELINE_ID))
      .resolves.toBe(`${PROXY}/${encodeURIComponent('user-timeline_aaa')}`)
    expect(calls).toHaveLength(2)
  })

  it('invalidate() 清掉退避：登出 / 库重建后能立刻重试', async () => {
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    // 未 invalidate 前在退避窗口内
    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    responseStatus = 200
    targets.invalidate()
    await expect(targets.remoteUrlForId(TIMELINE_ID)).resolves.toContain('user-timeline_aaa')
    expect(calls).toHaveLength(2)
  })

  it('离线时不发请求（直接按失败返回）', async () => {
    setOnline(false)
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow(/离线/)
    expect(calls).toHaveLength(0)
  })

  it('恢复联网（online 事件）后立刻清掉退避，不等 TTL', async () => {
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    // 先失败一次进入退避
    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow()
    expect(calls).toHaveLength(1)

    // 后端恢复 + 浏览器发出 online：退避必须被清掉，下一次调用立刻重试
    responseStatus = 200
    dispatchOnline()
    await expect(targets.remoteUrlForId(TIMELINE_ID)).resolves.toContain('user-timeline_aaa')
    expect(calls).toHaveLength(2)
  })

  it('失败不会制造 unhandled rejection（调用方都按契约 catch）', async () => {
    responseStatus = 500
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    // 两个调用点共用同一个 inflight，其中只有一个挂了 catch
    const a = targets.remoteUrlForId(TIMELINE_ID).catch(() => null)
    const b = targets.remoteUrlForId(TIMELINE_ID).catch(() => null)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    // 让微任务队列彻底排空
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', unhandled)
  })
})
