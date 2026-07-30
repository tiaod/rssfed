import { describe, it, expect } from 'vitest'
import { computed } from 'vue'
import { useFeedNavigation } from '../../composables/useFeedNavigation'
import type { SubscriptionItem } from '../../composables/useCouchDb'

describe('useFeedNavigation', () => {
  it('feeds 为 null 时返回空数组', () => {
    const { menuItems, hasFeeds } = useFeedNavigation(computed(() => null))
    expect(menuItems.value).toEqual([])
    expect(hasFeeds.value).toBe(false)
  })

  it('feeds 为空数组时返回空数组', () => {
    const { menuItems, hasFeeds } = useFeedNavigation(computed(() => []))
    expect(menuItems.value).toEqual([])
    expect(hasFeeds.value).toBe(false)
  })

  it('根据 feeds 生成导航菜单', () => {
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '' },
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '' },
    ]
    const { menuItems, hasFeeds } = useFeedNavigation(computed(() => feeds))

    expect(hasFeeds.value).toBe(true)
    expect(menuItems.value).toHaveLength(1)

    const group = menuItems.value[0]
    expect(group).toBeDefined()
    expect(group![0]).toMatchObject({ label: '订阅源', type: 'label' as const })
    expect(group![1]).toMatchObject({ label: 'Feed A', to: '/rss/feed/1' })
    expect(group![2]).toMatchObject({ label: 'Feed B', to: '/rss/feed/2' })
  })
})
