import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import NewEntriesBanner from '../../components/NewEntriesBanner.vue'

/**
 * 「已同步 N 条」提示条的形态与交互。
 *
 * 定性：一条常驻的细线——不按滚动方向隐藏（塌高度会让虚拟化抽风，留占位等于没隐藏），
 * 所以它靠把高度压到最紧来少占内容的地方；底部再压一条渐隐带，滚动经过的内容在它下缘
 * 淡出，不至于被一条硬边切断。
 */

const STUBS = {
  USeparator: {
    name: 'USeparator',
    template: '<div class="separator" data-slot="separator"><slot /></div>'
  },
  UIcon: { name: 'UIcon', props: ['name'], template: '<i class="icon" />' },
  UButton: {
    name: 'UButton',
    props: ['label'],
    emits: ['click'],
    template: '<button class="view-btn" @click="$emit(\'click\', $event)">{{ label }}</button>'
  }
}

/** 宿主复刻列表页布局：提示条与列表是兄弟 */
const Host = defineComponent({
  components: { NewEntriesBanner },
  props: { count: { type: Number, default: 0 } },
  emits: ['apply'],
  template: `
    <div class="panel">
      <NewEntriesBanner :count="count" @apply="$emit('apply')" />
      <div class="list"><div class="filler" /></div>
    </div>
  `
})

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

function mountBanner(count: number) {
  wrapper = mount(Host, { props: { count }, global: { stubs: STUBS } })
  return wrapper
}

const bannerEl = () => wrapper!.findComponent(NewEntriesBanner).element as HTMLElement

describe('NewEntriesBanner', () => {
  it('没有待查看内容时不占位：高度收起且对屏幕阅读器隐藏', () => {
    mountBanner(0)

    expect(wrapper!.text()).toContain('已同步 0 条')
    expect(bannerEl().className).toContain('grid-rows-[0fr]')
    expect(bannerEl().className).toContain('opacity-0')
    expect(bannerEl().getAttribute('aria-hidden')).toBe('true')
  })

  it('折叠时挂 inert（先把焦点清掉，aria-hidden 才不会撞上「后代仍有焦点」被浏览器拦截）', async () => {
    mountBanner(0)
    expect(bannerEl().hasAttribute('inert')).toBe(true)

    await wrapper!.setProps({ count: 2 })
    // 摘除必须靠 undefined：Vue 不把 inert 当特殊布尔属性，写 false 会渲染成 inert="false" 照样生效
    expect(bannerEl().hasAttribute('inert')).toBe(false)
    expect(bannerEl().getAttribute('aria-hidden')).toBeNull()
  })

  it('有待查看内容时展开，条数与按钮都在', () => {
    mountBanner(3)

    expect(wrapper!.text()).toContain('已同步 3 条')
    expect(bannerEl().className).toContain('grid-rows-[1fr]')
    expect(bannerEl().className).toContain('opacity-100')
    expect(bannerEl().getAttribute('aria-hidden')).toBeNull()
    expect(wrapper!.find('.view-btn').text()).toBe('查看')
  })

  it('高度压到最紧：不留底部内边距，与导航栏的间距也只有 mt-2 / sm:mt-3', () => {
    mountBanner(3)

    const separator = wrapper!.findComponent({ name: 'USeparator' })
    expect(separator.classes()).not.toContain('pb-3')
    expect(bannerEl().className).toContain('mt-2')
    expect(bannerEl().className).toContain('sm:mt-3')
    expect(bannerEl().className).not.toContain('mt-4')
  })

  it('底部压一条从底色到同色透明的渐隐带，且不拦点击（不影响文字本身）', () => {
    mountBanner(3)

    const fade = bannerEl().querySelector('.absolute')
    expect(fade).not.toBeNull()
    expect(fade!.className).toContain('top-full') // 在提示条之外，压的是下面列表的顶边
    expect(fade!.className).toContain('bg-linear-to-b')
    expect(fade!.className).toContain('from-[var(--ui-bg)]')
    // 透明端必须是与起点同色（带 /0）而不是 to-transparent：后者在 oklab 插值下中段泛灰
    expect(fade!.className).toContain('to-[var(--ui-bg)]/0')
    expect(fade!.className).not.toContain('to-transparent')
    expect(fade!.className).toContain('pointer-events-none')
  })

  it('点「查看」把决定权交回页面', async () => {
    mountBanner(2)

    await wrapper!.find('.view-btn').trigger('click')

    expect(wrapper!.emitted('apply')).toHaveLength(1)
  })

  it('点「查看」时焦点先还回页面：否则紧接着折叠挂 aria-hidden 会被浏览器拦截', async () => {
    // 要真聚焦就得挂进文档
    wrapper = mount(Host, { props: { count: 2 }, attachTo: document.body, global: { stubs: STUBS } })
    const btn = wrapper.find('.view-btn').element as HTMLElement
    btn.focus()
    expect(document.activeElement).toBe(btn)

    await wrapper.find('.view-btn').trigger('click')

    expect(document.activeElement).not.toBe(btn)
    expect(wrapper.emitted('apply')).toHaveLength(1)
  })

  it('同步让计数归零时收起，再来一批时重新展开', async () => {
    mountBanner(3)
    expect(bannerEl().className).toContain('grid-rows-[1fr]')

    await wrapper!.setProps({ count: 0 })
    expect(bannerEl().className).toContain('grid-rows-[0fr]')

    await wrapper!.setProps({ count: 5 })
    expect(wrapper!.text()).toContain('已同步 5 条')
    expect(bannerEl().className).toContain('grid-rows-[1fr]')
  })
})
