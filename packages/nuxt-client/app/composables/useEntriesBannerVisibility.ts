import type { MaybeRefOrGetter, Ref } from 'vue'
import { useScrollHideOnDown } from './useScrollHideOnDown'

/**
 * 列表页「已同步 N 条」浮层提示条的显隐。
 *
 * 组合两件事：
 *   - 滚动方向（见 `useScrollHideOnDown`）：向下滚时让位，向上滚或回到顶部时露出；
 *   - 计数变化时 `reveal()` 一次：用户正好在下滑的话，这次通知会被方向逻辑直接吃掉，
 *     不先露一下就等于没提示（reveal 自带保护窗口，见该 composable）。
 *
 * 页面侧只需：给列表容器加 `relative`，然后
 * `<NewEntriesBanner floating :count="newCount" :visible="bannerVisible" />`。
 */
export function useEntriesBannerVisibility(
  newCount: Ref<number>,
  anchor: MaybeRefOrGetter<HTMLElement | null | undefined>,
  options: { revealGuardMs?: number } = {}
) {
  const { visible, reveal } = useScrollHideOnDown(anchor, options)

  watch(newCount, (n, prev) => {
    // 只在「从无到有」时露一次。同步常常连着好几轮、每轮各带一批，若每轮都 reveal，
    // 提示条会被一直按在屏幕上（用户往下滚也收不起来）；用户点过「查看」计数归零后，
    // 下一批新条目自然还会再露。
    if (n > 0 && prev === 0) reveal()
  })

  return { visible }
}
