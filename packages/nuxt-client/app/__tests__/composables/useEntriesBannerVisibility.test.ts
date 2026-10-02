import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, nextTick, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useEntriesBannerVisibility } from '../../composables/useEntriesBannerVisibility'

/**
 * 浮层提示条的显隐：方向让位（下滑收起 / 上滑露出）+ 计数变化时先露一次
 * + 「只看未读」下整条收起（suppressed）。
 */

// 复刻 Nuxt auto-import：composable 内部直接引用全局 ref / watch / VueUse 函数
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref
nuxtGlobals.watch = watch
nuxtGlobals.useEventListener = useEventListener

/** 宿主：监听挂外层容器，真正滚动的是内部元素（与列表页结构一致） */
const Host = defineComponent({
  props: { guardMs: { type: Number, default: undefined } },
  setup(props) {
    const outer = ref<HTMLElement | null>(null)
    const newCount = ref(0)
    const suppressed = ref(false)
    const { visible } = useEntriesBannerVisibility(newCount, outer, {
      revealGuardMs: props.guardMs,
      suppressed
    })
    return { outer, newCount, suppressed, visible }
  },
  template: `
    <div ref="outer" class="outer">
      <div class="scroller" />
      <span class="state">{{ visible }}</span>
      <button class="add" @click="newCount = newCount + 3">add</button>
      <button class="suppress" @click="suppressed = !suppressed">suppress</button>
    </div>
  `
})

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

async function setup(guardMs?: number) {
  wrapper = mount(Host, { attachTo: document.body, props: { guardMs } })
  await nextTick()
  const scroller = wrapper.find('.scroller').element as HTMLElement

  async function scrollTo(top: number) {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
  }

  return {
    scrollTo,
    countUp: async () => {
      await wrapper!.find('.add').trigger('click')
      await nextTick()
    },
    toggleSuppressed: async () => {
      await wrapper!.find('.suppress').trigger('click')
      await nextTick()
    },
    state: () => wrapper!.find('.state').text()
  }
}

describe('useEntriesBannerVisibility', () => {
  it('默认可见；下滑让位、上滑露出', async () => {
    const { scrollTo, state } = await setup()
    expect(state()).toBe('true')

    await scrollTo(700)
    expect(state()).toBe('false')

    await scrollTo(400)
    expect(state()).toBe('true')
  })

  it('提示条收起时计数变正，先露一次——否则用户正在下滑，这次通知就没了', async () => {
    const { scrollTo, countUp, state } = await setup()

    await scrollTo(900)
    expect(state()).toBe('false')

    await countUp()
    expect(state()).toBe('true')
  })

  it('已经露过之后计数继续涨，不再反复把提示条按在屏幕上', async () => {
    // 保护窗口调小：这里要的是「窗口过后」，默认 1.2s 会让测试白等
    const { scrollTo, countUp, state } = await setup(50)

    await countUp() // 0 → 3：从无到有，露一次
    expect(state()).toBe('true')

    await new Promise(resolve => setTimeout(resolve, 80))
    await scrollTo(900) // 用户往下读 → 让位
    expect(state()).toBe('false')

    await countUp() // 3 → 6：同步又带了一批，但不该再把它翻出来
    expect(state()).toBe('false')
  })

  it('计数没变时不会硬露出来（同一轮同步只提示一次）', async () => {
    const { scrollTo, state } = await setup()

    await scrollTo(900)
    expect(state()).toBe('false')

    // 计数仍是 0：不该有任何 reveal
    await nextTick()
    expect(state()).toBe('false')
  })

  it('suppressed（只看未读）：计数再大也整条收起，期间涨计数也不翻出来', async () => {
    const { countUp, toggleSuppressed, state } = await setup()

    await countUp()
    expect(state()).toBe('true')

    await toggleSuppressed()
    expect(state()).toBe('false')

    // 未读模式下同步又带了一批：计数归零再涨会触发 reveal，但抑制优先
    await toggleSuppressed()
    expect(state()).toBe('true')
    await toggleSuppressed()
    await countUp()
    expect(state()).toBe('false')
  })

  it('退出 suppressed 且计数还在时补一次 reveal：否则用户停在列表中间就看不到这条提示', async () => {
    // 保护窗口调小：刚 countUp 过，需要等它过去才能靠滚动把提示条收起来
    const { scrollTo, countUp, toggleSuppressed, state } = await setup(50)

    await countUp() // 计数 3，提示条默认可见
    await new Promise(resolve => setTimeout(resolve, 80))
    await scrollTo(900) // 用户往下读 → 让位，收起
    expect(state()).toBe('false')

    await toggleSuppressed() // 进入只看未读 → 抑制
    expect(state()).toBe('false')

    // 抑制期间计数又涨（未读模式下同步仍在跑）：不显示
    await countUp()
    expect(state()).toBe('false')

    // 切回全部：计数还在，应主动露一次（此刻 scrollTop 仍在 900，靠 reveal 而不是方向逻辑）
    await toggleSuppressed()
    expect(state()).toBe('true')
  })
})
