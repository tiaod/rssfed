import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import NewEntriesBanner from '../../components/NewEntriesBanner.vue'

/**
 * 「已同步 N 条」提示条的形态与交互。
 *
 * 定性：一条细线，两种形态——常驻（参与布局，靠把高度压到最紧少占内容的地方）与浮层
 * （绝对定位盖在滚动区顶部，不占布局，能安全地按滚动方向显隐）。两种形态底部都压一条
 * 渐隐带，滚动经过的内容在它下缘淡出，不至于被一条硬边切断。
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
  props: {
    count: { type: Number, default: 0 },
    floating: { type: Boolean, default: false },
    visible: { type: Boolean, default: true }
  },
  emits: ['apply'],
  template: `
    <div class="panel">
      <NewEntriesBanner
        :count="count"
        :floating="floating"
        :visible="visible"
        @apply="$emit('apply')"
      />
      <div class="list"><div class="filler" /></div>
    </div>
  `
})

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

function mountBanner(count: number, extra: Record<string, unknown> = {}) {
  wrapper = mount(Host, { props: { count, ...extra }, global: { stubs: STUBS } })
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

  it('不传 visible 时默认可见（时间线 / 分类页 / Bot 产出页只传 count）', () => {
    // Vue 会把未传的 Boolean prop 填成 false，这里锁死默认值必须是 true——
    // 否则这些页面会把「已同步 N 条」整体折叠掉，用户以为提示没了
    wrapper = mount(NewEntriesBanner, { props: { count: 3 }, global: { stubs: STUBS } })
    const el = wrapper.element as HTMLElement

    expect(wrapper.text()).toContain('已同步 3 条')
    expect(el.className).toContain('grid-rows-[1fr]')
    expect(el.className).toContain('opacity-100')
    expect(el.getAttribute('aria-hidden')).toBeNull()
    expect(el.hasAttribute('inert')).toBe(false)
  })

  it('浮层形态：绝对定位盖在滚动区顶部、自带底色，且不带外边距（不参与布局才不会推动内容）', () => {
    mountBanner(3, { floating: true })

    const classes = bannerEl().className.split(' ')
    expect(classes).toContain('absolute')
    expect(classes).toContain('inset-x-0')
    expect(classes).toContain('top-0')
    // 互斥：relative 与 absolute 同时出现时谁生效取决于 CSS 顺序，浮层就白写了
    expect(classes).not.toContain('relative')
    // 盖在内容上必须有底色，否则文字会和下面的卡片叠在一起
    expect(bannerEl().className).toContain('bg-[var(--ui-bg)]')
    expect(classes).not.toContain('mt-2')
  })

  it('常驻形态保持参与布局的 relative 定位', () => {
    mountBanner(3)

    expect(bannerEl().className.split(' ')).toContain('relative')
    expect(bannerEl().className.split(' ')).not.toContain('absolute')
  })

  it('外部要求隐藏（visible=false）时按「无新条目」折叠：条数还在，但不可见也不可聚焦', () => {
    mountBanner(3, { visible: false })

    expect(wrapper!.text()).toContain('已同步 3 条')
    expect(bannerEl().className).toContain('grid-rows-[0fr]')
    expect(bannerEl().className).toContain('opacity-0')
    expect(bannerEl().getAttribute('aria-hidden')).toBe('true')
    expect(bannerEl().hasAttribute('inert')).toBe(true)
  })

  it('从隐藏切回可见时重新展开（滚动方向由页面决定）', async () => {
    mountBanner(3, { visible: false })
    expect(bannerEl().className).toContain('grid-rows-[0fr]')

    await wrapper!.setProps({ visible: true })
    expect(bannerEl().className).toContain('grid-rows-[1fr]')
    expect(bannerEl().getAttribute('aria-hidden')).toBeNull()
  })
})
