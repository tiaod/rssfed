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
 * 组件的 loading / toast 反馈另有用例（TimelineSidebar.test.ts）。
 */

const H = vi.hoisted(() => ({
  cloudRefresh: vi.fn(async () => null),
  storageRefresh: vi.fn(async () => {}),
  logLoad: vi.fn(async () => {}),
  queryEntryStates: vi.fn(async () => []),
  listSubscriptions: vi.fn(async () => [{ id: 'a' }, { id: 'b' }])
}))

// usePouchDb 在本项目里是 Nuxt 自动导入（composable 源码没有 import 语句），vi.mock 拦不到，
// 只能挂全局桩 —— 与 usePouchDb 系列单测同一套做法。
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

vi.mock('~/composables/useTimelineLog', async () => {
  const { ref: rf } = await import('vue')
  return {
    useTimelineLog: () => ({
      sources: rf([]),
      loading: rf(false),
      load: H.logLoad
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

beforeEach(() => {
  H.cloudRefresh.mockClear()
  H.storageRefresh.mockClear()
  H.logLoad.mockClear()
  H.queryEntryStates.mockClear()
  H.listSubscriptions.mockClear()
})

describe('useTimelineSidebar 的刷新口径', () => {
  it('挂载时自动刷一次，但走缓存（不强制）', async () => {
    await mountSidebar()

    expect(H.cloudRefresh).toHaveBeenCalledWith(false)
    expect(H.queryEntryStates).toHaveBeenCalledTimes(1)
    expect(H.logLoad).toHaveBeenCalledTimes(1)
  })

  it('手动刷新绕过云端体积的 60 秒缓存', async () => {
    const sidebar = await mountSidebar()
    H.cloudRefresh.mockClear()

    await sidebar.refreshNow()

    // force = true：否则 60 秒内点几次都是同一份旧数字
    expect(H.cloudRefresh).toHaveBeenCalledWith(true)
  })

  it('手动刷新也会重扫状态库与源水位表：小结和「哪个源失败」同样要新', async () => {
    const sidebar = await mountSidebar()
    H.queryEntryStates.mockClear()
    H.logLoad.mockClear()

    await sidebar.refreshNow()

    expect(H.queryEntryStates).toHaveBeenCalledTimes(1)
    expect(H.logLoad).toHaveBeenCalledTimes(1)
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
