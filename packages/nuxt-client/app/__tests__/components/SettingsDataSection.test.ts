import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

/**
 * 设置弹窗 →「数据」分区：同步日志的展开时机。
 *
 * 这里要钉住两件事：
 *   1. 默认折叠 —— 日志是调试面板，不该每次打开设置都多打一个接口；
 *   2. 时间线侧栏点了「查看同步日志」时（意图标记为真）挂载即展开并拉一次 ——
 *      用户点的是「看日志」，不是「打开设置后自己往下找」。
 *
 * 注意：本组件用到的 composable 都是 Nuxt 自动导入（源码里没有 import 语句），
 * `vi.mock` 拦不到，只能挂全局桩 —— 与项目里其它组件测试同一套做法。
 */

const H = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  loadMore: vi.fn(),
  clear: vi.fn(),
  loadBackgroundSync: vi.fn(async () => {}),
  clearBackgroundSync: vi.fn(),
  consumeTimelineLogIntent: vi.fn()
}))

// 组件里显式 import 的模块用 vi.mock 替换（useSettingsModal / useStorageEstimate /
// useLocalDbCleanup 都是显式 import 的）
vi.mock('~/composables/useSettingsModal', () => ({
  useSettingsModal: () => ({ consumeTimelineLogIntent: H.consumeTimelineLogIntent })
}))

vi.mock('~/composables/useStorageEstimate', async () => {
  const { ref } = await import('vue')
  return {
    formatBytes: () => '0 B',
    useStorageEstimate: () => ({
      info: ref(null),
      loading: ref(false),
      supported: ref(false),
      refresh: vi.fn()
    })
  }
})

vi.mock('~/composables/useLocalDbCleanup', async () => {
  const { ref } = await import('vue')
  return {
    useLocalDbCleanup: () => ({
      supported: ref(false),
      scanning: ref(false),
      cleaning: ref(false),
      error: ref(null),
      accountCount: ref(0),
      canClean: ref(false),
      scan: vi.fn(),
      clean: vi.fn()
    })
  }
})

// 自动导入的那些（源码里没有 import 语句）只能挂全局桩
const nuxtGlobals = globalThis as unknown as Record<string, unknown>

nuxtGlobals.useUserStore = () => ({ user: { id: 'user-a' } })
nuxtGlobals.useToast = () => ({ add: vi.fn() })
nuxtGlobals.usePouchDb = () => ({
  syncStatuses: reactive({}),
  resetLocalData: vi.fn(),
  syncNow: vi.fn()
})
nuxtGlobals.useTimelineLog = () => ({
  events: ref([]),
  sources: ref([]),
  heartbeat: ref(null),
  loaded: ref(false),
  loading: ref(false),
  clearing: ref(false),
  error: ref(null),
  canLoadMore: ref(false),
  load: H.load,
  loadMore: H.loadMore,
  clear: H.clear
})

nuxtGlobals.useBackgroundSyncLog = () => ({
  events: ref([]),
  summary: ref({ ok: 0, failed: 0, lastOkAt: null, supported: null }),
  loading: ref(false),
  clearing: ref(false),
  loaded: ref(false),
  load: H.loadBackgroundSync,
  clear: H.clearBackgroundSync
})

const STUBS = {
  UCard: { template: '<div><slot /></div>' },
  UButton: {
    inheritAttrs: false,
    props: ['label'],
    emits: ['click'],
    template: '<button v-bind="$attrs" @click="$emit(\'click\')">{{ label }}<slot /></button>'
  },
  UAlert: { template: '<div><slot /></div>' },
  UBadge: { template: '<span><slot /></span>' },
  UModal: { template: '<div><slot name="body" /><slot name="footer" /></div>' }
}

async function mountSection() {
  const { default: SettingsDataSection } = await import('../../components/settings/SettingsDataSection.vue')
  const wrapper = mount(SettingsDataSection, { global: { stubs: STUBS } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  H.load.mockReset().mockResolvedValue(undefined)
  H.loadBackgroundSync.mockReset().mockResolvedValue(undefined)
  H.consumeTimelineLogIntent.mockReset()
})

describe('SettingsDataSection（设置 → 数据）', () => {
  it('没有「展开日志」的意图：默认折叠，挂载时不请求', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(false)
    await mountSection()

    expect(H.load).not.toHaveBeenCalled()
  })

  it('带「展开日志」的意图挂载：直接展开并拉一次', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(true)
    const wrapper = await mountSection()

    expect(H.load).toHaveBeenCalledTimes(1)
    // 展开后才有「刷新 / 清空」这一排操作
    expect(wrapper.text()).toContain('刷新')
  })

  it('意图是一次性的：每次挂载都消费一次，不残留到下次打开', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(true)
    await mountSection()
    expect(H.consumeTimelineLogIntent).toHaveBeenCalledTimes(1)

    H.consumeTimelineLogIntent.mockReturnValue(false)
    H.load.mockClear()
    const second = await mountSection()
    expect(H.consumeTimelineLogIntent).toHaveBeenCalledTimes(2)
    expect(H.load).not.toHaveBeenCalled()
    expect(second.text()).not.toContain('刷新')
  })
})

/**
 * 后台同步面板（本机 IndexedDB 日志）。
 *
 * 与上面的服务端日志面板是两块独立面板，各自的折叠状态互不影响：
 * 「查看同步日志」的意图只该展开服务端那份，不该顺手把本机那份也拉一遍。
 */
describe('SettingsDataSection → 后台同步面板', () => {
  it('默认折叠，且挂载时不读本地日志', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(false)
    await mountSection()

    expect(H.loadBackgroundSync).not.toHaveBeenCalled()
  })

  it('「查看同步日志」的意图不会连带展开后台同步面板', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(true)
    await mountSection()

    expect(H.load).toHaveBeenCalledTimes(1)
    expect(H.loadBackgroundSync).not.toHaveBeenCalled()
  })

  it('点「查看」才读一次本地日志', async () => {
    H.consumeTimelineLogIntent.mockReturnValue(false)
    const wrapper = await mountSection()

    // 两个面板各有一个「查看」，后台同步那个是第二个
    const viewButtons = wrapper.findAll('button').filter(b => b.text() === '查看')
    expect(viewButtons.length).toBeGreaterThanOrEqual(2)

    await viewButtons[viewButtons.length - 1]!.trigger('click')
    await flushPromises()

    expect(H.loadBackgroundSync).toHaveBeenCalledTimes(1)
  })
})
