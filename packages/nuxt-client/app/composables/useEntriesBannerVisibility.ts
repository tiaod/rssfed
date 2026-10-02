import { computed, toValue, watch } from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'
import { useScrollHideOnDown } from './useScrollHideOnDown'

/**
 * 列表页「已同步 N 条」浮层提示条的显隐。
 *
 * 组合三件事：
 *   - 滚动方向（见 `useScrollHideOnDown`）：向下滚时让位，向上滚或回到顶部时露出；
 *   - 计数变化时 `reveal()` 一次：用户正好在下滑的话，这次通知会被方向逻辑直接吃掉，
 *     不先露一下就等于没提示（reveal 自带保护窗口，见该 composable）；
 *   - `suppressed`：整个提示条按「无新条目」收起（见下）。
 *
 * **`suppressed` 用于「只看未读」**：切进未读模式就是一次完整刷新（扫描不受列表快照约束，
 * 见 useUnreadFilter），同步刚写进来、还没点「查看」的条目此刻已经上屏了 —— 再顶一条
 * 「已同步 N 条」既重复又占位置。收起它只是不显示，待查看计数**不清零**（没走 load），
 * 退出只看未读后该提示照旧出现。
 *
 * 页面侧只需：给列表容器加 `relative`，然后
 * `<NewEntriesBanner floating :count="newCount" :visible="bannerVisible" />`。
 */
export function useEntriesBannerVisibility(
  newCount: Ref<number>,
  anchor: MaybeRefOrGetter<HTMLElement | null | undefined>,
  options: {
    /** 保护窗口时长（毫秒），默认 1200；测试里会调小 */
    revealGuardMs?: number
    /** 因当前模式（只看未读）整条收起：计数保留，只是不显示 */
    suppressed?: MaybeRefOrGetter<boolean>
  } = {}
) {
  const { visible, reveal } = useScrollHideOnDown(anchor, { revealGuardMs: options.revealGuardMs })

  watch(newCount, (n, prev) => {
    // 只在「从无到有」时露一次。同步常常连着好几轮、每轮各带一批，若每轮都 reveal，
    // 提示条会被一直按在屏幕上（用户往下滚也收不起来）；用户点过「查看」计数归零后，
    // 下一批新条目自然还会再露。
    if (n > 0 && prev === 0) reveal()
  })

  const suppressed = computed(() => toValue(options.suppressed) ?? false)

  // 退出抑制（从只看未读切回全部）时补一次 reveal：这段时间同步进来的计数还在，
  // 而用户多半正停在列表中间，不主动露一下这条提示会被方向逻辑吃掉。
  watch(suppressed, (now, before) => {
    if (before && !now && newCount.value > 0) reveal()
  })

  return { visible: computed(() => visible.value && !suppressed.value) }
}
