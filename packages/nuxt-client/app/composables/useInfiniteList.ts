/**
 * 无限滚动：底部哨兵元素进入视口时触发 loadMore()。
 *
 * 基于 @vueuse/core 的 useIntersectionObserver 实现（自动处理观察生命周期与目标切换），
 * 哨兵元素需放在滚动容器（UDashboardPanel body）底部；默认以视口为根，对嵌套滚动容器同样生效。
 *
 * loadMore 返回 true 表示可能还有更多数据，返回 false 表示已加载完毕。
 * 返回值里的 loadMore 是同一份带防重入保护的单飞入口：列表页把它同时交给底部哨兵与
 * 文章弹窗的尾部预加载，任何一方触发都共享同一把锁，不会并发倍增请求。
 */
export function useInfiniteList(
  next: () => Promise<boolean> | boolean,
  options: { rootMargin?: string } = {}
) {
  const sentinelRef = ref<HTMLElement | null>(null)
  const loading = ref(false) // 正在加载下一批
  const hasMore = ref(true) // 是否还有更多数据
  let busy = false // 防重入：同一时刻只处理一次加载

  /** 拉取下一批；正在加载或无更多时直接短路 */
  async function loadMore(): Promise<boolean> {
    if (busy || !hasMore.value) return hasMore.value
    busy = true
    loading.value = true
    try {
      // 返回 false 说明已无更多数据，停止后续触发
      if ((await next()) === false) hasMore.value = false
      return hasMore.value
    } finally {
      busy = false
      loading.value = false
    }
  }

  useIntersectionObserver(
    sentinelRef,
    (entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting) void loadMore()
    },
    {
      // 提前 300px 预加载，减少滚动到底的等待
      rootMargin: options.rootMargin ?? '300px 0px',
    }
  )

  return { sentinelRef, loading, hasMore, loadMore }
}
