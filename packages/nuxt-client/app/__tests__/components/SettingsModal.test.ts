import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsModal from '../../components/settings/SettingsModal.vue'

/**
 * 设置弹窗的窄屏两级结构 + 订阅管理入口。
 *
 * 钉住三件事：
 *   1. 窄屏先给「分区列表」，点一行才进详情，详情页左上角有返回键回到列表；
 *   2. 深链入口（open('data') / openSyncLog）不能停在列表上 —— 用户点的是「看日志」；
 *   3. 订阅管理不是分区：点击先关弹窗再跳转，否则跳页后设置还盖在上面。
 */

const H = vi.hoisted(() => ({
  close: vi.fn(),
  closeSidebar: vi.fn(),
  openUpdates: vi.fn(),
  section: { value: 'general' },
  pane: { value: 'menu' }
}))

vi.mock('~/composables/useAppSidebar', () => ({
  useAppSidebar: () => ({ isOpen: { value: false }, close: H.closeSidebar })
}))

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
      section: ref(H.section.value),
      pane: ref(H.pane.value),
      open: vi.fn(),
      close: H.close,
      openSyncLog: vi.fn(),
      consumeTimelineLogIntent: vi.fn()
    })
  }
})

/**
 * UModal：只渲染 content 槽，并把 `close` 以同样形状传进去。
 * openUpdates 记录「弹窗被要求收起」，订阅管理入口触发的正是这个函数。
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
    props: ['label', 'icon', 'trailingIcon', 'ariaLabel', 'color', 'variant'],
    emits: ['click'],
    template:
      '<button :data-icon="icon" :data-trailing="trailingIcon" :data-color="color" :data-variant="variant" :aria-label="ariaLabel" @click="$emit(\'click\')"><slot>{{ label }}</slot></button>'
  },
  UIcon: { name: 'Icon', template: '<i />' },
  SettingsGeneralSection: { name: 'SettingsGeneralSection', template: '<div class="general" />' },
  SettingsDataSection: { name: 'SettingsDataSection', template: '<div class="data" />' },
  McpSetupPanel: { name: 'McpSetupPanel', template: '<div class="ai" />' }
}

function mountModal() {
  H.pane.value = 'menu'
  H.section.value = 'general'
  return mount(SettingsModal, { global: { stubs: STUBS } })
}

function allButtons(wrapper: ReturnType<typeof mountModal>) {
  return wrapper.findAll('button')
}

/** 窄屏第一级里的一行：宽屏竖栏与窄屏共用 SettingsNav，所以只在 <nav> 容器里找 */
function listRow(wrapper: ReturnType<typeof mountModal>, label: string) {
  const nav = wrapper.find('nav')
  if (!nav.exists()) return undefined
  return nav.findAll('button').find(b => b.text().trim() === label)
}

/** 宽屏竖栏里的同一行（对照用：两边必须是同一套按钮） */
function asideRow(wrapper: ReturnType<typeof mountModal>, label: string) {
  const aside = wrapper.find('aside')
  if (!aside.exists()) return undefined
  return aside.findAll('button').find(b => b.text().trim() === label)
}

/** 订阅管理入口：窄屏列表里在 <nav> 内，宽屏在 <aside> 内 */
function subscriptionEntry(wrapper: ReturnType<typeof mountModal>) {
  return allButtons(wrapper).find(b => b.text().includes('订阅管理'))
}

function backButton(wrapper: ReturnType<typeof mountModal>) {
  return allButtons(wrapper).find(b => b.attributes('aria-label') === '返回设置列表')
}

describe('SettingsModal 窄屏分区列表', () => {
  beforeEach(() => {
    H.openUpdates.mockClear()
    H.close.mockClear()
    vi.mocked(navigateTo).mockClear()
  })

  it('第一级直接复用宽屏的分区导航，不再另做一套带边框的卡片', () => {
    const wrapper = mountModal()

    for (const label of ['常规', 'AI 助手', '数据']) {
      const row = listRow(wrapper, label)
      expect(row).toBeDefined()
      // 与宽屏竖栏同一套按钮：图标、无尾部 chevron
      expect(row?.attributes('data-icon')).toBe(asideRow(wrapper, label)?.attributes('data-icon'))
      expect(row?.attributes('data-trailing')).toBeUndefined()
    }
    // 列表页没有返回键（已经在顶层）
    expect(backButton(wrapper)).toBeUndefined()
  })

  it('列表行不标选中态：这一级只是入口，高亮一条会被读成「已选中」', () => {
    H.section.value = 'general'
    const wrapper = mountModal()

    for (const label of ['常规', 'AI 助手', '数据']) {
      const row = listRow(wrapper, label)!
      // 与未选中的宽屏行是同一种 ghost 按钮，不带 soft 底色
      expect(row.attributes('data-variant')).toBe('ghost')
      expect(row.attributes('aria-current')).toBeUndefined()
    }
  })

  it('宽屏竖栏仍标当前分区：高亮说明右边显示的是哪一块', () => {
    // 默认分区是「常规」（mock 里的 section 固定在构建时取值，所以断言默认态）
    const wrapper = mountModal()

    expect(asideRow(wrapper, '常规')?.attributes('data-variant')).toBe('soft')
    expect(asideRow(wrapper, '常规')?.attributes('aria-current')).toBe('page')
    expect(asideRow(wrapper, '数据')?.attributes('data-variant')).toBe('ghost')
  })

  it('点一行进入该分区详情，左侧导航不参与窄屏这两级', async () => {
    const wrapper = mountModal()

    await listRow(wrapper, '数据')!.trigger('click')

    // 详情页的标志：返回键出现、该分区内容挂上，列表行随之让位
    expect(backButton(wrapper)).toBeDefined()
    expect(wrapper.find('.data').exists()).toBe(true)
    expect(listRow(wrapper, '常规')).toBeUndefined()
  })

  it('详情页左上角有返回键，退回分区列表', async () => {
    H.pane.value = 'section'
    const wrapper = mount(SettingsModal, { global: { stubs: STUBS } })

    expect(backButton(wrapper)?.attributes('data-icon')).toBe('i-lucide-arrow-left')

    await backButton(wrapper)!.trigger('click')

    expect(backButton(wrapper)).toBeUndefined()
    expect(listRow(wrapper, '常规')).toBeDefined()
  })
})

describe('SettingsModal 的订阅管理入口', () => {
  beforeEach(() => {
    H.openUpdates.mockClear()
    H.close.mockClear()
    H.closeSidebar.mockClear()
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

  it('跳页时一并收起侧边栏：窄屏从抽屉进来时，同址跳转不会触发路由的 autoClose', async () => {
    const wrapper = mountModal()

    await subscriptionEntry(wrapper)!.trigger('click')
    await flushPromises()

    expect(H.closeSidebar).toHaveBeenCalledTimes(1)
    // 关侧边栏与关弹窗都要在跳转之前完成，否则跳完还盖着一层
    expect(H.closeSidebar.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(navigateTo).mock.invocationCallOrder[0]!
    )
  })
})
