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

  it('有分类的 feeds 生成可导航的分组菜单，未分类排最后', () => {
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '', category: '技术' },
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '', category: '技术' },
      { id: '3', title: 'Feed C', siteUrl: '', createdAt: '' },
    ]
    const { menuItems } = useFeedNavigation(computed(() => feeds))

    const group = menuItems.value[0]!
    expect(group).toHaveLength(3) // label + 分组 + 未分类 feed

    const tech = group[1]
    expect(tech).toMatchObject({
      label: '技术',
      to: `/rss/group/${encodeURIComponent('技术')}`,
      defaultOpen: true,
      children: [
        { label: 'Feed A', to: '/rss/feed/1' },
        { label: 'Feed B', to: '/rss/feed/2' },
      ],
    })
    expect(group[2]).toMatchObject({ label: 'Feed C', to: '/rss/feed/3' })
  })
})
