import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { DropdownMenuItem } from '@nuxt/ui'
import ListViewSwitcher from '../../components/ListViewSwitcher.vue'
import { LIST_VIEWS, LIST_VIEW_META, type ListView } from '../../utils/listViews'

/** UDropdownMenu 在单测里只暴露 items，方便断言菜单内容与触发事件 */
const STUBS = {
  UDropdownMenu: {
    name: 'DropdownMenu',
    props: ['items', 'content'],
    template: '<div class="menu"><slot /></div>'
  },
  UButton: {
    name: 'Button',
    props: ['icon', 'title', 'ariaLabel', 'variant', 'color', 'size'],
    template: '<button class="trigger" :data-icon="icon" :aria-label="ariaLabel" :title="title"><slot /></button>'
  }
}

function mountSwitcher(view: ListView, overridden = false) {
  return mount(ListViewSwitcher, {
    props: { view, overridden },
    global: { stubs: STUBS }
  })
}

function menuItems(wrapper: ReturnType<typeof mountSwitcher>): DropdownMenuItem[][] {
  return wrapper.findComponent({ name: 'DropdownMenu' }).props('items') as DropdownMenuItem[][]
}

/** 第一组（四种视图）；noUncheckedIndexedAccess 下取组要显式兜底 */
function viewItems(wrapper: ReturnType<typeof mountSwitcher>): DropdownMenuItem[] {
  return menuItems(wrapper)[0] ?? []
}

describe('ListViewSwitcher', () => {
  it('菜单列出全部视图，且只有当前视图带勾选态', () => {
    const items = viewItems(mountSwitcher('list'))

    expect(items.map(i => i.label)).toEqual(LIST_VIEWS.map(v => LIST_VIEW_META[v].label))
    expect(items.filter(i => i.checked)).toHaveLength(1)
    expect(items.find(i => i.checked)?.label).toBe(LIST_VIEW_META.list.label)
  })

  it('选中某一项就把视图切过去（不走 toggle 语义）', () => {
    const wrapper = mountSwitcher('masonry')
    const imageItem = viewItems(wrapper).find(i => i.label === LIST_VIEW_META.image.label)

    imageItem?.onUpdateChecked?.(true)

    expect(wrapper.emitted('update:view')?.[0]).toEqual(['image'])
  })

  it('触发按钮用统一的「切换视图」专用图标，不随当前视图变', async () => {
    const icons = new Set<string>()

    for (const view of LIST_VIEWS) {
      const wrapper = mountSwitcher(view)
      await nextTick()
      const trigger = wrapper.get('.trigger')
      icons.add(trigger.attributes('data-icon') ?? '')
      // 当前视图改由 tooltip / aria-label 交代
      expect(trigger.attributes('aria-label')).toContain(LIST_VIEW_META[view].label)
    }

    // 「点它会打开什么」要固定：六个视图共用一个图标，且不与菜单项里的版式图标重合
    expect(icons.size).toBe(1)
    expect([...icons][0]).toMatch(/^i-lucide-/)
    expect(LIST_VIEWS.map(v => LIST_VIEW_META[v].icon)).not.toContain([...icons][0])
  })

  it('触发按钮是纯图标：不排文字，靠 tooltip 说明「点击能切换」', async () => {
    const wrapper = mountSwitcher('blog')
    await nextTick()
    const trigger = wrapper.get('.trigger')

    // 导航栏右侧不排字：可点性靠 tooltip / aria-label（都带当前视图名）说明，视觉上与 ⋮ 等一致
    expect(trigger.text()).toBe('')
    expect(trigger.attributes('title')).toBe(`视图：${LIST_VIEW_META.blog.label}（点击切换）`)
    expect(trigger.attributes('aria-label')).toContain(LIST_VIEW_META.blog.label)
  })

  it('首帧按默认视图渲染 tooltip（避免 SSR hydration 属性不一致），挂载后再跟随实际视图', async () => {
    const wrapper = mountSwitcher('image')

    // 尚未 flush：服务端与客户端首帧必须是同一份 DOM，否则 Vue 只报 mismatch 不修正属性。
    // 图标是固定值，不受影响；会随视图变的是 tooltip 里的视图名。
    expect(wrapper.get('.trigger').attributes('title')).toBe(`视图：${LIST_VIEW_META.masonry.label}（点击切换）`)

    await nextTick()
    expect(wrapper.get('.trigger').attributes('title')).toBe(`视图：${LIST_VIEW_META.image.label}（点击切换）`)
  })

  it('没有会话内切换时不提供「恢复默认视图」', () => {
    expect(menuItems(mountSwitcher('masonry'))).toHaveLength(1)
  })

  it('会话内切过后提供「恢复默认视图」，点击后抛 reset', () => {
    const wrapper = mountSwitcher('image', true)
    const groups = menuItems(wrapper)

    expect(groups).toHaveLength(2)
    const resetItem = groups[1]?.[0]
    expect(resetItem?.label).toBe('恢复默认视图')

    resetItem?.onSelect?.(new Event('select'))

    expect(wrapper.emitted('reset')).toHaveLength(1)
  })
})
