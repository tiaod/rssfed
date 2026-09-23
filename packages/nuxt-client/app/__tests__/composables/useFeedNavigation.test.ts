import { describe, it, expect } from 'vitest'
import { computed } from 'vue'
import { useFeedNavigation } from '../../composables/useFeedNavigation'
import type { SubscriptionItem } from '../../types/rss'

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
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '' }
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

  it('feed 项带上图标懒加载所需的字段，分组项则不带', () => {
    // slot: 'feed' 让 UNavigationMenu 走侧边栏的 #feed-leading 插槽（FeedIcon 懒加载图标）
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '', category: '技术' },
      { id: 'bot:42', title: 'Bot 产出', siteUrl: '', createdAt: '', kind: 'bot' }
    ]
    const { menuItems } = useFeedNavigation(computed(() => feeds))

    const group = menuItems.value[0]!
    const techGroup = group[1]!
    expect(techGroup.children![0]).toMatchObject({
      label: 'Feed A',
      to: '/rss/feed/1',
      slot: 'feed',
      feedId: '1',
      fallbackText: 'F'
    })
    // bot 订阅走 bot 产出页，同样交给 FeedIcon
    expect(group[2]).toMatchObject({
      label: 'Bot 产出',
      to: '/bots/42/posts',
      slot: 'feed',
      feedId: 'bot:42',
      fallbackText: 'B'
    })
    // 分类分组项自身不是订阅源，不该带 feedId（否则会被塞一个图标）
    expect(techGroup).toMatchObject({ label: '技术' })
    expect(techGroup.feedId).toBeUndefined()
    expect(techGroup.slot).toBeUndefined()
  })

  it('有分类的 feeds 生成可导航的分组菜单，未分类排最后', () => {
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '', category: '技术' },
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '', category: '技术' },
      { id: '3', title: 'Feed C', siteUrl: '', createdAt: '' }
    ]
    const { menuItems } = useFeedNavigation(computed(() => feeds))

    const group = menuItems.value[0]!
    expect(group).toHaveLength(3) // label + 分组 + 未分类 feed

    const tech = group[1]
    expect(tech).toMatchObject({
      label: '技术',
      to: `/rss/group/${encodeURIComponent('技术')}`,
      // 默认折叠：几百个源全展开会让几百个菜单项同时进 DOM
      defaultOpen: false,
      value: 'cat:技术',
      children: [
        { label: 'Feed A', to: '/rss/feed/1' },
        { label: 'Feed B', to: '/rss/feed/2' }
      ]
    })
    expect(group[2]).toMatchObject({ label: 'Feed C', to: '/rss/feed/3' })
  })

  it('只默认展开当前路由所在的分组', () => {
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '', category: '技术' },
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '', category: '生活' }
    ]

    // 停在某个分类页：该分类展开
    const byCategory = useFeedNavigation(computed(() => feeds), {
      activeCategory: computed(() => '生活')
    })
    const catGroups = byCategory.menuItems.value[0]!
    const pick = (label: string) => catGroups.find(g => g?.label === label)
    expect(pick('技术')).toMatchObject({ defaultOpen: false })
    expect(pick('生活')).toMatchObject({ defaultOpen: true })
    expect(byCategory.activeCategoryGroupValue.value).toBe('cat:生活')

    // 停在某个源页：该源所在分组展开
    const byFeed = useFeedNavigation(computed(() => feeds), {
      activeFeedId: computed(() => '1')
    })
    const feedGroups = byFeed.menuItems.value[0]!
    const pickFeed = (label: string) => feedGroups.find(g => g?.label === label)
    expect(pickFeed('技术')).toMatchObject({ defaultOpen: true })
    expect(pickFeed('生活')).toMatchObject({ defaultOpen: false })
    expect(byFeed.activeCategoryGroupValue.value).toBe('cat:技术')

    // 停在时间线这类与订阅无关的页面：全部折叠
    const none = useFeedNavigation(computed(() => feeds))
    expect(none.activeCategoryGroupValue.value).toBeNull()
    expect(none.menuItems.value[0]!.find(g => g?.label === '技术')).toMatchObject({ defaultOpen: false })
  })

  it('未分类的源没有分组可折叠，仍作为顶层项渲染', () => {
    const feeds: SubscriptionItem[] = [
      { id: '1', title: 'Feed A', siteUrl: '', createdAt: '', category: '技术' },
      { id: '2', title: 'Feed B', siteUrl: '', createdAt: '' }
    ]
    const { menuItems } = useFeedNavigation(computed(() => feeds))
    const group = menuItems.value[0]!
    // label 项 + 技术分组（折叠）+ 未分类的 Feed B
    expect(group).toHaveLength(3)
    expect(group[2]).toMatchObject({ label: 'Feed B', feedId: '2' })
  })
})
