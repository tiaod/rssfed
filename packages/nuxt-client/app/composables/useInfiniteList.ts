/**
 * 无限滚动：底部哨兵元素进入视口时触发 loadMore()。
 *
 * 基于 @vueuse/core 的 useIntersectionObserver 实现（自动处理观察生命周期与目标切换），
 * 哨兵元素需放在滚动容器（UDashboardPanel body）底部；默认以视口为根，对嵌套滚动容器同样生效。
 *
 * loadMore 返回 true 表示可能还有更多数据，返回 false 表示已加载完毕。
 */
export function useInfiniteList(
  loadMore: () => Promise<boolean> | boolean,
  options: { rootMargin?: string } = {}
) {
  const sentinelRef = ref<HTMLElement | null>(null)
  const loading = ref(false) // 正在加载下一批
  const hasMore = ref(true) // 是否还有更多数据
  let busy = false // 防重入：同一时刻只处理一次加载

  useIntersectionObserver(
    sentinelRef,
    async (entries) => {
      const entry = entries[0]
      if (!entry?.isIntersecting || busy || !hasMore.value) return
      busy = true
      loading.value = true
      try {
        // 返回 false 说明已无更多数据，停止后续触发
        if ((await loadMore()) === false) hasMore.value = false
      } finally {
        busy = false
        loading.value = false
      }
    },
    {
      // 提前 300px 预加载，减少滚动到底的等待
      rootMargin: options.rootMargin ?? '300px 0px',
    }
  )

  return { sentinelRef, loading, hasMore }
}
