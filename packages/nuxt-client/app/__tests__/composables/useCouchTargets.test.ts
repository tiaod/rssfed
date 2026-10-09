import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useRuntimeConfig 是 Nuxt auto-import，测试环境手动补上（见 app/__tests__/setup.ts 的同类处理）
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.useRuntimeConfig = () => ({ public: { apiBaseUrl: 'http://localhost:3001' } })

const BASE = 'http://localhost:3001'
const PROXY = `${BASE}/api/couchdb/proxy`

/** 记录的 targets 接口调用（用于验证缓存） */
let calls: string[] = []
let responseStatus = 200
let responseBody: Record<string, unknown> = {}

const realFetch = globalThis.fetch

beforeEach(() => {
  // 模块级缓存跨用例共享，重置模块以拿到干净状态
  vi.resetModules()
  calls = []
  responseStatus = 200
  responseBody = {
    timeline: 'user-timeline_aaa',
    userState: 'user-state_bbb'
  }
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
})

describe('useCouchTargets', () => {
  it('两个同步目标各自拼出带真实库名的代理地址', async () => {
    const { useCouchTargets, TIMELINE_ID, USER_STATE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID))
      .resolves.toBe(`${PROXY}/${encodeURIComponent('user-timeline_aaa')}`)
    await expect(targets.remoteUrlForId(USER_STATE_ID))
      .resolves.toBe(`${PROXY}/${encodeURIComponent('user-state_bbb')}`)
    // 打的是只查这两个库的 /sync-targets（旧的 /targets 会为每个订阅源查一次库名）
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
    const { useCouchTargets, TIMELINE_ID, USER_STATE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await targets.remoteUrlForId(TIMELINE_ID)
    await targets.remoteUrlForId(USER_STATE_ID)
    await targets.remoteUrlForId(TIMELINE_ID)
    expect(calls).toHaveLength(1)
  })

  it('invalidate 后重新拉取（订阅变更 / 库重建场景）', async () => {
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await targets.remoteUrlForId(TIMELINE_ID)
    targets.invalidate()
    responseBody = { timeline: 'user-timeline_ccc', userState: 'user-state_bbb' }

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
    responseBody = { userState: 'user-state_bbb' }
    const { useCouchTargets, TIMELINE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(TIMELINE_ID)).rejects.toThrow(/timeline/)
  })

  it('响应缺少 userState 时抛错', async () => {
    responseBody = { timeline: 'user-timeline_aaa' }
    const { useCouchTargets, USER_STATE_ID } = await loadComposable()
    const targets = useCouchTargets()

    await expect(targets.remoteUrlForId(USER_STATE_ID)).rejects.toThrow(/userState/)
  })
})
