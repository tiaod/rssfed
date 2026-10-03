import { computed, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import type { ListView } from '~/utils/listViews'

/**
 * 宽屏「列表 + 常驻阅读栏」两栏布局的判据（加上左侧订阅源侧边栏就是三栏）。
 *
 * 只有「列表」视图走三栏：瀑布流 / 博客文章 / 图片 / 表格是为了「一屏扫过很多条」而存在的，
 * 给它们再切掉四成宽度等于把版式意图毁掉；那几种视图保持点击弹窗的原行为。
 *
 * 断点取 Tailwind 的 lg：Nuxt UI 的 UDashboardSidebar 正是 `hidden lg:flex`，
 * lg 以下侧边栏整块消失 —— 三栏都放得下时阅读栏才成立。
 */
export const READER_PANE_MIN_WIDTH = 1024

/**
 * 会用到阅读栏的页面（四个列表页 + 收藏页）。路由是布局判断「这一页有没有第三栏」的第二把锁：
 * 页面卸载时不去清共享状态（页面切换在 Suspense 下的挂载 / 卸载顺序不保证，
 * 谁清谁写会互相打架），改成「不在列表页就一律不算」。
 *
 * 单源页读某一篇时的地址（`/rss/feed/:id/entry/:entryId`）仍算列表页：那只是同一页上的
 * 详情地址（见 useEntryRoute），阅读栏不该在点开一篇的瞬间整块消失、换成弹窗。
 */
const READER_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/timeline$/,
  /^\/saved$/,
  /^\/rss\/feed\/[^/]+$/,
  /^\/rss\/feed\/[^/]+\/entry\/[^/]+$/,
  /^\/rss\/group\/[^/]+$/,
  /^\/bots\/[^/]+\/posts$/
]

/** 阅读栏宽度的下限（rem）：再窄正文就成一条了 */
export const READER_PANE_MIN_REM = 20

/** 阅读栏宽度的绝对上限（rem）：一行上百字并不好读，给到 80rem(1280px) 已经远超正常阅读宽度 */
export const READER_PANE_MAX_REM = 80

/** 中间那栏要保住的最小宽度、左侧边栏的默认宽度（rem，它自身可拖可折叠，这里按主题默认值算） */
const LIST_FLOOR_REM = 18
const SIDEBAR_DEFAULT_REM = 15

/**
 * 阅读栏的拖动上限（rem），跟着视口走。
 *
 * 固定上限在两种窗口上都不合适：窗口小而之前拖得很宽 → 中间那栏被挤没；窗口很大 → 想拖宽却拖不动。
 * 所以上限 = min(绝对上限, 视口宽 - 侧边栏 - 中间那栏的下限)。
 * EntryReaderPane 用它当 `max-size`，同一表达式也作为 root 的 max-width（见那里的注释）：
 * 两处必须一致，否则会出现「拖了却不变宽」。
 */
export function readerPaneMaxSizeRem(viewportWidth: number): number {
  const allowed = viewportWidth / 16 - SIDEBAR_DEFAULT_REM - LIST_FLOOR_REM
  return Math.max(READER_PANE_MIN_REM, Math.min(READER_PANE_MAX_REM, allowed))
}

/** 当前路由是不是会用到阅读栏的列表页 */
export function isReaderRoute(path: string): boolean {
  return READER_ROUTE_PATTERNS.some(pattern => pattern.test(path))
}

/**
 * 当前是否宽屏（≥lg）。
 *
 * SSR 与客户端首帧一律按 false 渲染，挂载后再按真实视口切换 —— 与 layout 里的 compactSidebar
 * 同一口径，避免服务端产物与客户端首帧不一致导致 hydration mismatch。
 */
export function useReaderPaneWide() {
  const wide = useState<boolean>('reader-pane-wide', () => false)

  if (import.meta.client) {
    const mql = window.matchMedia(`(min-width: ${READER_PANE_MIN_WIDTH}px)`)

    const sync = () => {
      wide.value = mql.matches
    }

    onMounted(() => {
      sync()
      mql.addEventListener('change', sync)
    })

    onBeforeUnmount(() => {
      mql.removeEventListener('change', sync)
    })
  }

  return wide
}

/**
 * 列表页把「当前生效的视图」发布给布局。
 *
 * 阅读栏挂在布局里（它是面板的同级一栏，见 layouts/default.vue），拿不到页面级的视图解析
 * （订阅源 / 分组各自的默认值要读本地库）。发布方是 useListViewState()，五个列表页都走它，
 * 页面侧不需要额外接线。卸载时不清理：路由兜底已经能保证非列表页不会渲染阅读栏，
 * 而清理反而会和「新页面已经写好了」的时序打架。
 *
 * `ready` 为假时**不发布**（保留上一页发布的值）：订阅源 / 分组的默认视图要读本地库，
 * 解析完成前 `view` 只是个暂定值。把它发布出去会让三栏在切页的瞬间塌成弹窗、等偏好读完
 * 再弹回来 —— 切到另一个源时正文会被「交回」弹窗，看起来就是文章突然变成弹窗。
 */
export function useReaderPaneView(view: Ref<ListView>, ready?: () => boolean) {
  const published = useState<ListView | null>('reader-pane-view', () => null)
  const isReady = () => (ready ? ready() : true)

  // 同时听 view 与 ready：偏好读完时 view 可能没变（暂定值恰好就是最终值），那时也要补一次发布
  watch([view, isReady], ([next, ok]) => {
    if (!ok) return
    published.value = next
  }, { immediate: true })
}

/** 宽屏 + 列表视图 + 列表页：三个条件同时成立才走三栏，否则详情一律走弹窗（保持原行为） */
export function useReaderPaneMode() {
  const wide = useReaderPaneWide()
  const route = useRoute()
  const published = useState<ListView | null>('reader-pane-view', () => null)

  return computed(() => wide.value && isReaderRoute(route.path) && published.value === 'list')
}
