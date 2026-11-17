import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsModal from '../../components/settings/SettingsModal.vue'

/**
 * 设置弹窗的订阅管理入口。
 *
 * 它不切换分区：点下去要先关弹窗再跳转。弹窗挂在 default 布局上、不属于任何页面，
 * 跳页不会卸载它 —— 漏掉 close 的话订阅管理页上会压着一层设置，所以这两件事的
 * 先后顺序在这里钉住。
 */

const H = vi.hoisted(() => ({ openUpdates: vi.fn() }))

vi.mock('~/composables/useSettingsModal', async () => {
  const { ref } = await import('vue')
  return {
    SETTINGS_SECTIONS: [
      { value: 'general', label: '常规', icon: 'i-lucide-settings-2' },
      { value: 'ai', label: 'AI 助手', icon: 'i-lucide-bot' },
      { value: 'data', label: '数据', icon: 'i-lucide-database' }
    ],
    useSettingsModal: () => ({
      isOpen: ref(true),
      section: ref('general'),
      open: vi.fn(),
      close: vi.fn(),
      openSyncLog: vi.fn(),
      consumeTimelineLogIntent: vi.fn()
    })
  }
})

/**
 * UModal：只渲染 content 槽，并把 `close` 以同样形状传进去。
 * openUpdates 记录的就是「弹窗被要求收起」，订阅管理入口按钮触发的正是这个函数。
 * 不用真 UModal：它依赖 reka 的 Portal / focus 管理，单测里没有能挂的场景。
 */
const STUBS = {
  UModal: {
    name: 'Modal',
    props: ['open', 'title', 'close', 'ui'],
    emits: ['update:open'],
    template: `<div v-if="open" class="modal">
      <slot name="content" :close="onClose" />
    </div>`,
    setup(_props: unknown, { emit }: { emit: (event: string, value: boolean) => void }) {
      return {
        onClose: () => {
          H.openUpdates(false)
          emit('update:open', false)
        }
      }
    }
  },
  UButton: {
    name: 'Button',
    props: ['label', 'icon', 'trailingIcon', 'ariaLabel'],
    emits: ['click'],
    template:
      '<button :data-icon="icon" :data-trailing="trailingIcon" :aria-label="ariaLabel" @click="$emit(\'click\')"><slot>{{ label }}</slot></button>'
  },
  UIcon: { name: 'Icon', template: '<i />' },
  SettingsGeneralSection: { name: 'SettingsGeneralSection', template: '<div class="general" />' },
  SettingsDataSection: { name: 'SettingsDataSection', template: '<div class="data" />' },
  McpSetupPanel: { name: 'McpSetupPanel', template: '<div class="ai" />' }
}

function mountModal() {
  return mount(SettingsModal, { global: { stubs: STUBS } })
}

/** 订阅管理入口（桌面上只有竖导航一个，窄屏横排标签里还有另一个） */
function subscriptionEntry(wrapper: ReturnType<typeof mountModal>) {
  return wrapper.findAll('button').find(b => b.text().includes('订阅管理'))
}

describe('SettingsModal 的订阅管理入口', () => {
  beforeEach(() => {
    H.openUpdates.mockClear()
    vi.mocked(navigateTo).mockClear()
  })

  it('带一个表示「会离开这里」的尾部图标', () => {
    const entry = subscriptionEntry(mountModal())

    expect(entry).toBeDefined()
    expect(entry?.attributes('data-icon')).toBe('i-lucide-rss')
    expect(entry?.attributes('data-trailing')).toBe('i-lucide-external-link')
  })

  it('点击先关弹窗再跳转，避免设置盖在订阅管理页上', async () => {
    const wrapper = mountModal()

    await subscriptionEntry(wrapper)!.trigger('click')
    await flushPromises()

    // 先关：弹窗挂在默认布局上、不在页面里，跳页不会卸载它
    expect(H.openUpdates).toHaveBeenCalledWith(false)
    expect(navigateTo).toHaveBeenCalledWith('/subscriptions')
    expect(H.openUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(navigateTo).mock.invocationCallOrder[0]!
    )
  })
})
