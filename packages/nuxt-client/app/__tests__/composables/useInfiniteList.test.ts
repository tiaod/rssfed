import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useInfiniteList } from '../../composables/useInfiniteList'

/**
 * 无限滚动的加载入口：只负责「单飞防重入 + 还有没有更多」。
 *
 * 触发时机不在这里——页尾骨架的可见性由 EntryList 里的 IntersectionObserver 观察
 * （骨架跟着瀑布流的列排在各列末尾）。这里锁住的是：不管谁触发，同一时刻只发一次请求。
 */

// 复刻 Nuxt auto-import：composable 内部直接引用全局 ref
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref

describe('useInfiniteList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadMore 单飞：并发触发（骨架进视口 + 弹窗预加载）只发一次请求', async () => {
    let settle: ((more: boolean) => void) | undefined
    const next = vi.fn(() => new Promise<boolean>((resolve) => {
      settle = resolve
    }))
    const list = useInfiniteList(next)

    const first = list.loadMore()
    const second = list.loadMore()

    expect(next).toHaveBeenCalledTimes(1)
    expect(list.loading.value).toBe(true)

    settle!(true)
    await Promise.all([first, second])

    expect(list.hasMore.value).toBe(true)
    expect(list.loading.value).toBe(false)
  })

  it('返回 true 表示还有更多，可以接着加载', async () => {
    const next = vi.fn(async () => true)
    const list = useInfiniteList(next)

    await list.loadMore()
    await list.loadMore()

    expect(next).toHaveBeenCalledTimes(2)
    expect(list.hasMore.value).toBe(true)
  })

  it('返回 false 表示加载完毕，之后不再请求', async () => {
    const next = vi.fn(async () => false)
    const list = useInfiniteList(next)

    await list.loadMore()
    expect(list.hasMore.value).toBe(false)

    await list.loadMore()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('加载失败时也会释放锁，不会卡住后续加载', async () => {
    const next = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true)
    const list = useInfiniteList(next)

    await expect(list.loadMore()).rejects.toThrow('boom')
    expect(list.loading.value).toBe(false)

    await list.loadMore()
    expect(next).toHaveBeenCalledTimes(2)
  })
})
