import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TimelineSidebar from '../../components/TimelineSidebar.vue'

/**
 * 时间线右栏：手动刷新按钮。
 *
 * 要钉住的是「点下去有反应」这件事本身 —— 这一栏最早的毛病就是按钮点了完全没动静：
 * 自动刷新走 60 秒缓存，点一下既没有网络请求、也没有 loading、更没有文案变化，
 * 用户只能怀疑按钮坏了。所以这里断言三条可观测的反馈：
 *   1. 点按钮触发一次刷新调用；
 *   2. 刷新进行中按钮处于 loading（`data-loading`），结束后收回；
 *   3. 结束后给出 toast（而不是静默完成）。
 *
 * 数据源全部替身：这条用例只关心组件与 `useTimelineSidebar` 的接线，不重测汇总口径
 * （那些在 utils/syncStatusSummary / readingStats 的单测里）。
 */
const H = vi.hoisted(() => ({
  refreshNow: vi.fn(),
  toastAdd: vi.fn(),
  /** 由 refreshNow 替身驱动的 loading（真实现里是 composable 的 refreshing） */
  refreshing: null as { value: boolean } | null
}))

vi.mock('~/composables/useTimelineSidebar', async () => {
  const { ref } = await import('vue')
  H.refreshing = ref(false) as unknown as { value: boolean }
  return {
    useTimelineSidebar: () => ({
      syncState: ref('success'),
      syncLabel: ref('同步成功'),
      lastSyncedText: ref('刚刚'),
      cloudText: ref('600.0 MB · 6400 条'),
      localText: ref('700.0 MB'),
      problemSources: ref({ items: [], more: 0 }),
      feedCount: ref(128),
      /**
       * 替身照抄真实现的契约：进来先把 refreshing 置真、出去置假。
       * 加载态由组件渲染，这里只负责让那个 ref 真的动起来。
       */
      refreshNow: (...args: unknown[]) => {
        H.refreshing!.value = true
        return Promise.resolve(H.refreshNow(...args)).finally(() => {
          H.refreshing!.value = false
        })
      },
      refreshing: H.refreshing,
      digest: ref({ today: 36, week: 188, total: 1495, saved: 2, savedUnread: 0 }),
      digestLoaded: ref(true)
    })
  }
})

vi.mock('~/composables/useSettingsModal', () => ({
  useSettingsModal: () => ({ openSyncLog: vi.fn() })
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useToast = () => ({ add: H.toastAdd })

const STUBS = {
  UCard: {
    name: 'UCard',
    template: '<div><slot name="header" /><slot /></div>'
  },
  UTooltip: {
    name: 'UTooltip',
    props: ['text'],
    template: '<div class="tooltip" :data-text="text"><slot /></div>'
  },
  UButton: {
    name: 'UButton',
    inheritAttrs: false,
    props: ['loading', 'icon'],
    emits: ['click'],
    template: '<button v-bind="$attrs" :data-loading="String(loading)" @click="$emit(\'click\')" />'
  },
  ULink: {
    name: 'ULink',
    props: ['to'],
    template: '<a><slot /></a>'
  }
}

function mountSidebar() {
  return mount(TimelineSidebar, { global: { stubs: STUBS } })
}

/** 卡片头部那颗刷新按钮（无障碍名是它的稳定标识，文案另有 tooltip） */
function refreshButton(wrapper: ReturnType<typeof mountSidebar>) {
  return wrapper.get('button[aria-label="重新读取同步状态"]')
}

beforeEach(() => {
  H.refreshNow.mockReset()
  H.toastAdd.mockReset()
})

describe('TimelineSidebar 的手动刷新', () => {
  it('点刷新就真的刷一轮，结束后给 toast', async () => {
    H.refreshNow.mockResolvedValue(true)
    const wrapper = mountSidebar()

    await refreshButton(wrapper).trigger('click')
    await flushPromises()

    expect(H.refreshNow).toHaveBeenCalledTimes(1)
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '已刷新' }))
  })

  it('刷新进行中按钮是 loading，完成后收回', async () => {
    let finish!: (value: boolean) => void
    H.refreshNow.mockReturnValue(new Promise<boolean>((resolve) => {
      finish = resolve
    }))
    const wrapper = mountSidebar()

    await refreshButton(wrapper).trigger('click')
    await flushPromises()
    // 转起来的那一下就是「点到了」的证据：否则几百毫秒里界面一片死寂
    expect(refreshButton(wrapper).attributes('data-loading')).toBe('true')

    finish(true)
    await flushPromises()
    expect(refreshButton(wrapper).attributes('data-loading')).toBe('false')
  })

  it('重入被 composable 拒掉时不再多报一次「已刷新」', async () => {
    H.refreshNow.mockResolvedValue(false)
    const wrapper = mountSidebar()

    await refreshButton(wrapper).trigger('click')
    await flushPromises()

    // 上一轮还在跑：事实是什么都没发生，就不能给成功提示
    expect(H.toastAdd).not.toHaveBeenCalled()
  })

  it('tooltip 说明这是「跳过缓存」的重新读取，而不只是刷新界面', () => {
    const wrapper = mountSidebar()
    const tooltip = wrapper.get('.tooltip')

    expect(tooltip.attributes('data-text')).toContain('重新读取')
  })
})
