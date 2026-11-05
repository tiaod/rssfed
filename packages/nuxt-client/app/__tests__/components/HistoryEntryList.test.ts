import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import HistoryEntryList from '../../components/HistoryEntryList.vue'
import type { RssEntry } from '../../types/rss'

/**
 * 历史页专用视图：按阅读日期分组、日期分割线、阅读时刻、触底加载。
 *
 * 组件用 VueUse 的 useIntersectionObserver 观察页尾哨兵；这里把它换成一个可以手动触发的
 * 假实现（与 EntryList.test.ts 同一套全局注入口径），滚动行为不依赖 happy-dom。
 */

const testGlobals = globalThis as unknown as Record<string, unknown>
let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
testGlobals.useIntersectionObserver = vi.fn((_target: unknown, cb: typeof observerCallback) => {
  observerCallback = cb
  return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
})

function at(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

function makeEntry(id: string, readAt: string | undefined, title: string): RssEntry {
  return {
    id,
    feedId: 'f1',
    feed: {
      id: 'f1',
      title: '少数派',
      siteUrl: 'https://sspai.com',
      feedUrl: 'https://sspai.com/feed',
      lastFetchedAt: at(2026, 11, 1)
    },
    title,
    url: `https://example.com/${id}`,
    publishedAt: at(2026, 11, 1),
    insertedAt: at(2026, 11, 1),
    read: true,
    starred: false,
    readingTime: 1,
    readAt
  }
}

const today = at(2026, 11, 5, 19, 3)
const earlierToday = at(2026, 11, 5, 9, 5)
const yesterday = at(2026, 11, 4, 22, 0)

const entries = [
  makeEntry('a', today, '今天下午读的'),
  makeEntry('b', earlierToday, '今天上午读的'),
  makeEntry('c', yesterday, '昨天读的')
]

describe('HistoryEntryList', () => {
  // 组头是相对日期（今天 / 昨天），固定「现在」，否则用例会随运行日期漂移
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 5, 20, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('按阅读日期分组，组头显示相对日期，条目显示具体阅读时刻', () => {
    const wrapper = mount(HistoryEntryList, { props: { entries } })

    expect(wrapper.findAll('h2').map(h => h.text())).toEqual(['今天', '昨天'])
    expect(wrapper.text()).toContain('19:03')
    expect(wrapper.text()).toContain('09:05')
    expect(wrapper.text()).toContain('22:00')
  })

  it('缺 readAt 的老条目仍展示，但不显示时刻', () => {
    const wrapper = mount(HistoryEntryList, {
      props: { entries: [makeEntry('old', undefined, '老的阅读记录')] }
    })

    expect(wrapper.find('h2').text()).toBe('更早')
    expect(wrapper.text()).toContain('老的阅读记录')
    expect(wrapper.find('time').exists()).toBe(false)
  })

  it('点击条目把该条抛给页面（由页面统一打开详情、维护上一篇/下一篇上下文）', async () => {
    const wrapper = mount(HistoryEntryList, { props: { entries } })

    await wrapper.findAll('button')[0]!.trigger('click')

    expect(wrapper.emitted('open')?.[0]?.[0]).toMatchObject({ id: 'a' })
  })

  it('页尾哨兵进入视口时请求下一批', () => {
    const loadMore = vi.fn()
    mount(HistoryEntryList, { props: { entries, loadMore } })

    observerCallback?.([{ isIntersecting: true }])
    expect(loadMore).toHaveBeenCalledTimes(1)

    observerCallback?.([{ isIntersecting: false }])
    expect(loadMore).toHaveBeenCalledTimes(1)
  })
})
