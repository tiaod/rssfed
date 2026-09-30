import type { MaybeRefOrGetter } from 'vue'

/**
 * 滚动方向显隐：向下滚（内容往上走，用户在往后读）时隐藏，向上滚或回到顶部时显示。
 *
 * 给「盖在内容上」的浮层用——它挡着最上面一条内容，往下读时让位，回头找它时再露出来。
 * 千万别把它用在参与布局的元素上：高度变化会让滚动容器的内容整体重排（列表虚拟化尤其怕这个）。
 *
 * `target` 传**滚动容器的祖先**即可（ScrollArea 这类组件内部的滚动元素拿不到时，从外面
 * 用捕获阶段收事件）：scroll 不冒泡，只有捕获阶段才会经过祖先，事件目标才是真正的滚动元素。
 *
 * 返回的 `reveal()` 供「有新内容要提示」时调用：否则用户正好在往下读，这次通知会被直接吃掉。
 */

/** 滚动超过这么多像素才认方向：滤掉惯性滚动的高频抖动，免得提示条闪烁 */
const DIRECTION_THRESHOLD = 4

/** 离顶部这么近就一律露出（用户滚回来看的就是最新内容） */
const TOP_THRESHOLD = 8

export function useScrollHideOnDown(target: MaybeRefOrGetter<HTMLElement | null | undefined>) {
  const visible = ref(true)
  let lastScrollTop = 0

  useEventListener(
    target,
    'scroll',
    (event: Event) => {
      const scroller = event.target
      if (!(scroller instanceof HTMLElement)) return
      const top = scroller.scrollTop
      const delta = top - lastScrollTop
      lastScrollTop = top
      if (Math.abs(delta) < DIRECTION_THRESHOLD) return
      visible.value = top <= TOP_THRESHOLD || delta < 0
    },
    { capture: true, passive: true }
  )

  function reveal() {
    visible.value = true
  }

  return { visible, reveal }
}
