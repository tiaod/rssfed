import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useScrollHideOnDown } from '../../composables/useScrollHideOnDown'

/**
 * 滚动方向显隐：给盖在内容上的浮层用——向下滚（内容往上走）时让位，向上滚或回顶部时露出。
 */

// 复刻 Nuxt auto-import：composable 内部直接引用全局 ref / VueUse 函数
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref
nuxtGlobals.useEventListener = useEventListener

/**
 * 宿主复刻列表页的结构：监听挂在**外层容器**上，真正滚动的是内部元素，
 * 事件也从内部元素发出（scroll 不冒泡，只有捕获阶段会经过外层）。
 */
const Host = defineComponent({
  setup() {
    const outer = ref<HTMLElement | null>(null)
    const { visible, reveal } = useScrollHideOnDown(outer)
    return { outer, visible, reveal }
  },
  template: `
    <div ref="outer" class="outer">
      <div class="scroller" />
      <span class="state">{{ visible }}</span>
      <button class="reveal" @click="reveal">reveal</button>
    </div>
  `
})

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

async function setup() {
  wrapper = mount(Host, { attachTo: document.body })
  // useEventListener 要等挂载后的下一个 tick 才绑到元素上
  await nextTick()
  const scroller = wrapper.find('.scroller').element as HTMLElement

  /** 改滚动位置再从内部元素发 scroll，等价于真实滚动；等一次渲染再断言 */
  async function scrollTo(top: number) {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
  }

  return {
    scrollTo,
    state: () => wrapper!.find('.state').text()
  }
}

describe('useScrollHideOnDown', () => {
  it('向下滚隐藏、向上滚显示', async () => {
    const { scrollTo, state } = await setup()
    expect(state()).toBe('true')

    await scrollTo(300)
    expect(state()).toBe('false')

    await scrollTo(120)
    expect(state()).toBe('true')
  })

  it('回到顶部一律显示', async () => {
    const { scrollTo, state } = await setup()

    await scrollTo(600)
    expect(state()).toBe('false')

    await scrollTo(4)
    expect(state()).toBe('true')
  })

  it('微小抖动不改状态：惯性滚动的高频事件不该让提示条闪', async () => {
    const { scrollTo, state } = await setup()

    await scrollTo(400)
    expect(state()).toBe('false')

    await scrollTo(402)
    await scrollTo(401)
    expect(state()).toBe('false')

    await scrollTo(300)
    expect(state()).toBe('true')
  })

  it('reveal() 立刻显示：新提示不该被「正在下滑」吃掉', async () => {
    const { scrollTo, state } = await setup()

    await scrollTo(800)
    expect(state()).toBe('false')

    await wrapper!.find('.reveal').trigger('click')
    expect(state()).toBe('true')
  })
})
