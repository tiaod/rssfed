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
    userState: 'user-state_aaa',
    feeds: { f1: 'feed_f1' },
    bots: { b1: 'bot_b1' }
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
  it('按业务 id 拼出带真实库名的代理地址', async () => {
    const { useCouchTargets, USER_STATE_ID } = await loadComposable()
    const targets = useCouchTargets()

    expect(await targets.remoteUrlForId('f1')).toBe(`${PROXY}/feed_f1`)
    expect(await targets.remoteUrlForId('bot:b1')).toBe(`${PROXY}/bot_b1`)
    expect(await targets.remoteUrlForId(USER_STATE_ID)).toBe(`${PROXY}/user-state_aaa`)

    // 三次取地址只拉一次 targets
    expect(calls).toEqual([`${BASE}/api/couchdb/targets`])
  })

  it('缓存里没有该 id 时，冷却期内不重复刷新（返回 null）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { useCouchTargets } = await loadComposable()
    const targets = useCouchTargets()

    expect(await targets.remoteUrlForId('unknown')).toBeNull()
    expect(calls).toHaveLength(1)

    vi.useRealTimers()
  })

  it('冷却期过后仍未命中会强制刷新一次', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { useCouchTargets } = await loadComposable()
    const targets = useCouchTargets()

    expect(await targets.remoteUrlForId('unknown')).toBeNull()
    expect(calls).toHaveLength(1)

    // 越过冷却期（10s）：允许再拉一次，拿别的设备刚建的订阅
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    expect(await targets.remoteUrlForId('unknown')).toBeNull()
    expect(calls).toHaveLength(2)

    vi.useRealTimers()
  })

  it('invalidate 后重新拉取（订阅变更场景）', async () => {
    const { useCouchTargets } = await loadComposable()
    const targets = useCouchTargets()

    await targets.remoteUrlForId('f1')
    targets.invalidate()
    responseBody = { userState: 'user-state_aaa', feeds: { f1: 'feed_f1', f2: 'feed_f2' }, bots: {} }

    expect(await targets.remoteUrlForId('f2')).toBe(`${PROXY}/feed_f2`)
    expect(calls).toHaveLength(2)
  })

  it('接口失败时抛错，不返回半成品缓存', async () => {
    responseStatus = 500
    const { useCouchTargets } = await loadComposable()

    await expect(useCouchTargets().remoteUrlForId('f1')).rejects.toThrow('HTTP 500')
  })

  it('响应缺少 userState 时抛错（避免拿 undefined 拼地址）', async () => {
    responseBody = { feeds: { f1: 'feed_f1' } }
    const { useCouchTargets } = await loadComposable()

    await expect(useCouchTargets().remoteUrlForId('f1')).rejects.toThrow('缺少 userState')
  })
})
