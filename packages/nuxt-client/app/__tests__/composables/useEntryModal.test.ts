import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, computed, watch, nextTick } from 'vue'
import { useEntryModal } from '../../composables/useEntryModal'
import type { RssEntry } from '../../types/rss'

// 复刻 Nuxt auto-import：useState 按 key 全局单例，ref/watch/computed 直接用 vue 的实现
const stateCache = new Map<string, any>()
;(globalThis as any).useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()))
  return stateCache.get(key)
})
;(globalThis as any).ref = ref
;(globalThis as any).watch = watch
;(globalThis as any).computed = computed

function makeEntry(n: number): RssEntry {
  return {
    id: `entry-${n}`,
    feedId: 'feed-1',
    title: `标题 ${n}`,
    url: `https://example.com/${n}`,
    publishedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0,
  }
}

describe('useEntryModal', () => {
  beforeEach(() => {
    stateCache.clear()
    vi.clearAllMocks()
  })

  it('openEntry 打开弹窗并设置当前条目；closeEntry 关闭并清空列表上下文', () => {
    const { isOpen, currentEntry, openEntry, closeEntry, canGoNext } = useEntryModal()
    const entry = makeEntry(1)

    expect(isOpen.value).toBe(false)
    openEntry(entry, () => [entry])
    expect(isOpen.value).toBe(true)
    expect(currentEntry.value?.id).toBe('entry-1')
    expect(canGoNext.value).toBe(false) // 只有一条，无可翻

    closeEntry()
    expect(isOpen.value).toBe(false)
  })

  it('沿列表在上一篇/下一篇之间移动，并且在两端停止', () => {
    const list = [makeEntry(1), makeEntry(2), makeEntry(3)]
    const { currentEntry, openEntry, goPrev, goNext, canGoPrev, canGoNext } = useEntryModal()

    openEntry(list[1]!, () => list)

    // 初始在中位：两边都可翻
    expect(canGoPrev.value).toBe(true)
    expect(canGoNext.value).toBe(true)

    // 上一篇 -> 列表前一位
    const moved = goPrev()
    expect(moved?.id).toBe('entry-1')
    expect(currentEntry.value?.id).toBe('entry-1')
    expect(canGoPrev.value).toBe(false)
    expect(canGoNext.value).toBe(true)
    // 已到最前，继续上一篇不移动
    expect(goPrev()).toBeNull()
    expect(currentEntry.value?.id).toBe('entry-1')

    // 两连下一篇 -> 到最后一条
    goNext()
    goNext()
    expect(currentEntry.value?.id).toBe('entry-3')
    expect(canGoNext.value).toBe(false)
    expect(goNext()).toBeNull()
    expect(currentEntry.value?.id).toBe('entry-3')
  })

  it('列表是取值函数而非快照：无限滚动加载新条目后可翻范围随之扩大', () => {
    // 用 ref 反映真实列表是响应式数据（页面里为 entries ref / props），推入新条目应扩大翻页范围
    const list = ref([makeEntry(1), makeEntry(2)])
    const { currentEntry, openEntry, goNext, canGoNext } = useEntryModal()

    openEntry(list.value[0]!, () => list.value)
    expect(currentEntry.value?.id).toBe('entry-1')

    // 第一条时只能往下翻一条
    expect(canGoNext.value).toBe(true)
    goNext()
    expect(currentEntry.value?.id).toBe('entry-2')
    expect(canGoNext.value).toBe(false)

    // 新一批条目推入后，同样位置的 next 又可用了
    list.value.push(makeEntry(3))
    expect(canGoNext.value).toBe(true)
    goNext()
    expect(currentEntry.value?.id).toBe('entry-3')
  })

  it('当前条目不在列表中时前后翻页均不可用', () => {
    const { openEntry, goPrev, goNext, canGoPrev, canGoNext, closeEntry } = useEntryModal()

    openEntry(makeEntry(1), () => [makeEntry(9)])
    expect(canGoPrev.value).toBe(false)
    expect(canGoNext.value).toBe(false)
    expect(goPrev()).toBeNull()
    expect(goNext()).toBeNull()

    closeEntry()
  })

  it('滑到倒数第三篇时自动触发一次预加载；列表长度未变前不重复触发，跨过新尾部后再触发', async () => {
    const list = ref(Array.from({ length: 10 }, (_, i) => makeEntry(i + 1)))
    let cursor = 10
    // loadMore 同步「拉回」一批，模拟列表变长
    const loadMore = vi.fn(() => {
      for (let i = 0; i < 5; i++) list.value.push(makeEntry(++cursor))
    })
    const hasMore = vi.fn(() => true)

    const { openEntry, goNext } = useEntryModal()
    // 打开时已位于倒数第三条（idx 7 = 10 - 3）内 → 触发首轮预加载
    openEntry(list.value[7]!, () => list.value, { loadMore, hasMore })
    await nextTick()
    expect(loadMore).toHaveBeenCalledTimes(1)

    // 触发后列表已变长到 15，此处离新尾部很远，继续滑不触发
    goNext()
    await nextTick()
    expect(loadMore).toHaveBeenCalledTimes(1)

    // 一路滑到新的倒数第三条（idx 12）→ 再次触发
    for (let i = 0; i < 4; i++) goNext()
    expect(list.value).toHaveLength(15)
    await nextTick()
    expect(loadMore).toHaveBeenCalledTimes(2)
  })

  it('没有更多数据（hasMore 为假）时不再触发预加载，并在停在末条时上报 isLastWithNoMore', async () => {
    const list = [makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4)]
    const loadMore = vi.fn()
    const hasMore = vi.fn(() => false)

    const { openEntry, goNext, isLastWithNoMore } = useEntryModal()

    // 位于倒数第三条但已无更多可加载 → 不触发
    openEntry(list[1]!, () => list, { loadMore, hasMore })
    await nextTick()
    expect(loadMore).not.toHaveBeenCalled()

    // 滑到最后一条：isLastWithNoMore 成立，继续翻不应再静默失败
    goNext() // 倒数第二条（idx 2）
    goNext() // 最后一条（idx 3）
    expect(isLastWithNoMore()).toBe(true)
    expect(goNext()).toBeNull()
  })

  it('未注入加载上下文时既不预加载也不标记尽头', async () => {
    const list = [makeEntry(1), makeEntry(2), makeEntry(3)]
    const { openEntry, isLastWithNoMore } = useEntryModal()

    openEntry(list[0]!, () => list) // 不带 loader 的静态列表
    await nextTick()
    expect(isLastWithNoMore()).toBe(false)
  })
})
