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
 */
const READER_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/timeline$/,
  /^\/saved$/,
  /^\/rss\/feed\/[^/]+$/,
  /^\/rss\/group\/[^/]+$/,
  /^\/bots\/[^/]+\/posts$/
]

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
 */
export function useReaderPaneView(view: Ref<ListView>) {
  const published = useState<ListView | null>('reader-pane-view', () => null)

  watch(view, (next) => {
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
