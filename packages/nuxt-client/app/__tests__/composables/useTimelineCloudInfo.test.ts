import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 云端聚合库体积的读取。
 *
 * 数字来自 CouchDB `GET /{db}`：三种体积口径不能混（external / active / file，见 composable
 * 头注释），这里盯的是「取哪一档、拿不到时安静降级、缓存别把请求打散」。
 */

const H = vi.hoisted(() => ({
  url: null as string | null,
  calls: [] as string[],
  status: 200,
  body: {} as Record<string, unknown>
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: async () => H.url
  })
}))

const PROXY_URL = 'http://localhost:3001/api/couchdb/proxy/user-timeline_aaa'
const realFetch = globalThis.fetch

beforeEach(() => {
  vi.resetModules()
  H.url = PROXY_URL
  H.calls = []
  H.status = 200
  H.body = {
    db_name: 'user-timeline_aaa',
    doc_count: 4965,
    doc_del_count: 15846,
    update_seq: '101534-g1AAAA',
    sizes: { file: 1_155_535_294, external: 796_947_140, active: 663_131_709 }
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    H.calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (H.status !== 200) return new Response('{}', { status: H.status })
    return new Response(JSON.stringify(H.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function loadComposable() {
  return await import('~/composables/useTimelineCloudInfo')
}

describe('readCloudInfo', () => {
  it('裁出条数与三档体积（external 才是估同步量的那一档）', async () => {
    const { readCloudInfo } = await loadComposable()
    const info = readCloudInfo(H.body)
    expect(info).toEqual({
      docCount: 4965,
      externalSize: 796_947_140,
      activeSize: 663_131_709,
      fileSize: 1_155_535_294,
      updateSeq: '101534-g1AAAA'
    })
  })

  it('缺 sizes 时体积字段为 null，不把「不知道」编成 0', async () => {
    const { readCloudInfo } = await loadComposable()
    const info = readCloudInfo({ doc_count: 3 })
    expect(info).toEqual({
      docCount: 3,
      externalSize: null,
      activeSize: null,
      fileSize: null,
      updateSeq: null
    })
  })

  it('没有 doc_count 的响应不认（代理根路径返回的是欢迎信息，不是库信息）', async () => {
    const { readCloudInfo } = await loadComposable()
    expect(readCloudInfo({ couchdb: 'Welcome', version: 'rssfed-proxy' })).toBeNull()
    expect(readCloudInfo(null)).toBeNull()
  })
})

describe('useTimelineCloudInfo', () => {
  it('经代理地址读库信息并填进 info', async () => {
    const { useTimelineCloudInfo } = await loadComposable()
    const { info, refresh } = useTimelineCloudInfo()

    const result = await refresh()
    expect(H.calls).toEqual([PROXY_URL])
    expect(result?.externalSize).toBe(796_947_140)
    expect(info.value?.docCount).toBe(4965)
  })

  it('缓存期内不重复请求；force 才重新读', async () => {
    const { useTimelineCloudInfo } = await loadComposable()
    const { refresh } = useTimelineCloudInfo()

    await refresh()
    await refresh()
    expect(H.calls).toHaveLength(1)

    H.body = { ...H.body, doc_count: 5100 }
    await refresh(true)
    expect(H.calls).toHaveLength(2)
  })

  it('并发调用合并成一个请求（指示器与进度条同时挂载）', async () => {
    const { useTimelineCloudInfo } = await loadComposable()
    const { refresh } = useTimelineCloudInfo()

    await Promise.all([refresh(), refresh(), refresh()])
    expect(H.calls).toHaveLength(1)
  })

  it('换账号（远端库 URL 变了）时不吃上一个账号的缓存', async () => {
    const { useTimelineCloudInfo } = await loadComposable()
    const { refresh, info } = useTimelineCloudInfo()

    await refresh()
    expect(info.value?.docCount).toBe(4965)

    // 库名是每账号随机的：URL 变了就必须重新读，不能把上一个账号的体积显示给当前账号
    H.url = 'http://localhost:3001/api/couchdb/proxy/user-timeline_bbb'
    H.body = { doc_count: 3, sizes: { external: 100 } }
    await refresh()

    expect(H.calls).toHaveLength(2)
    expect(info.value?.docCount).toBe(3)
  })

  it('读失败（401/离线/代理 404）时安静降级：不抛错、info 保持 null', async () => {
    H.status = 500
    const { useTimelineCloudInfo } = await loadComposable()
    const { info, refresh } = useTimelineCloudInfo()

    await expect(refresh()).resolves.toBeNull()
    expect(info.value).toBeNull()
  })

  it('取不到远端库名（未登录）时不发请求', async () => {
    H.url = null
    const { useTimelineCloudInfo } = await loadComposable()
    const { refresh, info } = useTimelineCloudInfo()

    await expect(refresh()).resolves.toBeNull()
    expect(H.calls).toHaveLength(0)
    expect(info.value).toBeNull()
  })
})
