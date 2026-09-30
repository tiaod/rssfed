/**
 * 无限滚动的加载入口：单飞防重入 + 「还有没有更多」状态。
 *
 * 触发时机不在这里——页尾加载骨架的可见性由 `EntryList` 里的 IntersectionObserver 观察
 * （骨架跟着瀑布流的列排在各列末尾，而不是一个独立的哨兵元素）。
 *
 * 这里保证的是：无论谁触发——骨架进入视口，还是文章弹窗的尾部预加载——同一时刻只发一次
 * 请求。列表页把这份 loadMore 同时交给 EntryList 与弹窗，两者共享同一把锁。
 *
 * loadMore 返回 true 表示可能还有更多数据，返回 false 表示已加载完毕。
 */
export function useInfiniteList(next: () => Promise<boolean> | boolean) {
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

  return { loading, hasMore, loadMore }
}
