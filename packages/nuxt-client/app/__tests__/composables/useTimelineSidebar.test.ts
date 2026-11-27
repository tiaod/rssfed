import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useTimelineSidebar } from '../../composables/useTimelineSidebar'

/**
 * 时间线右栏的数据口子：自动刷新走缓存、手动刷新必须绕过缓存。
 *
 * 这个区别不是性能优化，而是按钮能不能用的分水岭：云端库体积在 useTimelineCloudInfo 里
 * 有 60 秒缓存，手动刷新如果照旧命中缓存，点几下数字都纹丝不动 —— 用户看到的就是
 * 「这个刷新按钮坏了」。所以这里盯住 refreshNow 到底把 force 传下去没有。
 *
 * 「哪个源失败了」的数据源也在这里钉住：新模型下每源抓取状态写在用户库的 `_local/schedule`，
 * 由订阅列表接口读出来，不再有服务端的「源水位表」接口可调。
 *
 * 组件的 loading / toast 反馈另有用例（TimelineSidebar.test.ts）。
 */

const H = vi.hoisted(() => ({
  cloudRefresh: vi.fn(async () => null),
  storageRefresh: vi.fn(async () => {}),
  subscriptions: vi.fn(async () => [] as Array<Record<string, unknown>>),
  queryEntryStates: vi.fn(async () => []),
  listSubscriptions: vi.fn(async () => [{ id: 'a' }, { id: 'b' }])
}))

// usePouchDb / useApi 在本项目里是 Nuxt 自动导入（composable 源码没有 import 语句），
// vi.mock 拦不到，只能挂全局桩 —— 与 usePouchDb 系列单测同一套做法。
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.usePouchDb = () => ({
  queryEntryStates: H.queryEntryStates,
  listSubscriptions: H.listSubscriptions,
  stateVersion: ref(0),
  timelineVersion: ref(0),
  subscriptionsVersion: ref(0),
  syncStatuses: {},
  paused: ref(false),
  storageBroken: ref(null)
})
testGlobals.useApi = () => ({ feeds: { subscriptions: H.subscriptions } })

vi.mock('~/composables/useTimelineCloudInfo', async () => {
  const { ref: rf } = await import('vue')
  return {
    useTimelineCloudInfo: () => ({
      info: rf(null),
      loading: rf(false),
      refresh: H.cloudRefresh
    })
  }
})

vi.mock('~/composables/useStorageEstimate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/composables/useStorageEstimate')>()
  const { ref: rf } = await import('vue')
  return {
    ...actual,
    useStorageEstimate: () => ({
      info: rf(null),
      loading: rf(false),
      supported: rf(false),
      refresh: H.storageRefresh
    })
  }
})

/** onMounted 里会跑一轮自动刷新，必须挂进组件才拿得到返回值 */
async function mountSidebar() {
  let api!: ReturnType<typeof useTimelineSidebar>
  mount(defineComponent({
    setup() {
      api = useTimelineSidebar()
      return () => h('div')
    }
  }))
  await flushPromises()
  return api
}

/** 一条订阅在列表接口里的形状（只列本模块用到的字段） */
function sub(over: Record<string, unknown> = {}) {
  return {
    feedId: 'f1',
    title: '源',
    status: 'active',
    ...over
  }
}

beforeEach(() => {
  H.cloudRefresh.mockClear()
  H.storageRefresh.mockClear()
  H.subscriptions.mockReset().mockResolvedValue([])
  H.queryEntryStates.mockClear()
  H.listSubscriptions.mockClear()
})

describe('useTimelineSidebar 的刷新口径', () => {
  it('挂载时自动刷一次，但走缓存（不强制）', async () => {
    await mountSidebar()

    expect(H.cloudRefresh).toHaveBeenCalledWith(false)
    expect(H.queryEntryStates).toHaveBeenCalledTimes(1)
    expect(H.subscriptions).toHaveBeenCalledTimes(1)
  })

  it('手动刷新绕过云端体积的 60 秒缓存', async () => {
    const sidebar = await mountSidebar()
    H.cloudRefresh.mockClear()

    await sidebar.refreshNow()

    // force = true：否则 60 秒内点几次都是同一份旧数字
    expect(H.cloudRefresh).toHaveBeenCalledWith(true)
  })

  it('手动刷新也会重扫状态库与订阅列表：小结和「哪个源失败」同样要新', async () => {
    const sidebar = await mountSidebar()
    H.queryEntryStates.mockClear()
    H.subscriptions.mockClear()

    await sidebar.refreshNow()

    expect(H.queryEntryStates).toHaveBeenCalledTimes(1)
    expect(H.subscriptions).toHaveBeenCalledTimes(1)
  })

  it('重入时直接返回 false，不再并发打第二轮', async () => {
    const sidebar = await mountSidebar()
    // 第一轮卡住不返回：模拟「正在刷」
    let release!: () => void
    H.cloudRefresh.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(null)
    }))

    const first = sidebar.refreshNow()
    await flushPromises()
    expect(sidebar.refreshing.value).toBe(true)

    const second = await sidebar.refreshNow()
    expect(second).toBe(false)

    release()
    await first
    expect(sidebar.refreshing.value).toBe(false)
  })

  it('刷新进行中 refreshing 为真，结束后归假（按钮的 loading 就认它）', async () => {
    const sidebar = await mountSidebar()

    expect(sidebar.refreshing.value).toBe(false)
    await sidebar.refreshNow()
    expect(sidebar.refreshing.value).toBe(false)
  })
})

describe('useTimelineSidebar 的失败源', () => {
  it('订阅列表里的 error 与失败文案都算「有源出问题」', async () => {
    H.subscriptions.mockResolvedValue([
      sub({ feedId: 'ok', title: '正常源' }),
      sub({ feedId: 'bad', title: '失败源', status: 'error' }),
      // 状态回到 active 但还挂着上次的错误文案：一样要提醒
      sub({ feedId: 'stale', title: '上次失败', errorMessage: '超时' })
    ])
    const sidebar = await mountSidebar()

    expect(sidebar.problemSources.value.known).toBe(true)
    expect(sidebar.problemSources.value.items.map(i => i.id)).toEqual(['bad', 'stale'])
    expect(sidebar.problemSources.value.more).toBe(0)
  })

  it('只列前三个，其余折成「另有 N 个」', async () => {
    H.subscriptions.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map(id => sub({ feedId: id, status: 'error' })))
    const sidebar = await mountSidebar()

    expect(sidebar.problemSources.value.items).toHaveLength(3)
    expect(sidebar.problemSources.value.more).toBe(2)
  })

  it('订阅列表还没读到过时 known=false（不把「不知道」显示成「没问题」）', async () => {
    H.subscriptions.mockRejectedValue(new Error('offline'))
    const sidebar = await mountSidebar()

    expect(sidebar.problemSources.value.known).toBe(false)
    expect(sidebar.problemSources.value.items).toEqual([])
  })

  it('上次同步取本地复制与订阅列表里较新的那个', async () => {
    H.subscriptions.mockResolvedValue([
      sub({ feedId: 'a', lastFetchedAt: '2026-10-17T06:00:00.000Z' }),
      sub({ feedId: 'b', lastFetchedAt: '2026-10-17T08:00:00.000Z' })
    ])
    const sidebar = await mountSidebar()

    // 本地没有同步记录（syncStatuses 为空）时回落到服务端抓取时刻
    expect(sidebar.lastSyncedText.value).not.toBe('还没有记录')
  })
})
