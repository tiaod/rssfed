import { describe, it, expect } from 'vitest'
import { ref, computed } from 'vue'
import type { Feed } from '~/lib/miniflux/types'
import type { NavigationMenuItem } from '@nuxt/ui'
import { useFeedNavigation } from '~/composables/useFeedNavigation'

function createFeed(overrides: Partial<Feed> & { id: number }): Feed {
  return {
    user_id: 1,
    title: `Feed ${overrides.id}`,
    site_url: 'https://example.org',
    feed_url: 'https://example.org/feed.xml',
    checked_at: '2024-01-01T00:00:00Z',
    etag_header: '',
    last_modified_header: '',
    parsing_error_message: '',
    parsing_error_count: 0,
    scraper_rules: '',
    rewrite_rules: '',
    crawler: false,
    blocklist_rules: '',
    keeplist_rules: '',
    user_agent: '',
    username: '',
    password: '',
    disabled: false,
    ignore_http_cache: false,
    fetch_via_proxy: false,
    ...overrides
  }
}

function findGroup(items: NavigationMenuItem[][], label: string): NavigationMenuItem {
  const group = items[0]?.find(g => g.label === label)
  expect(group).toBeDefined()
  return group!
}

describe('useFeedNavigation', () => {
  it('feeds为null时返回空菜单', () => {
    const feeds = computed(() => null)
    const { menuItems, hasFeeds } = useFeedNavigation(feeds)

    expect(menuItems.value).toEqual([])
    expect(hasFeeds.value).toBe(false)
  })

  it('feeds为空数组时返回空菜单', () => {
    const feeds = computed(() => [])
    const { menuItems, hasFeeds } = useFeedNavigation(feeds)

    expect(menuItems.value).toEqual([])
    expect(hasFeeds.value).toBe(false)
  })

  it('按分类分组feeds，使用children实现折叠', () => {
    const feeds = computed(() => [
      createFeed({
        id: 1,
        title: 'Tech Blog',
        category: { id: 10, title: '技术', user_id: 1, hide_globally: false }
      }),
      createFeed({
        id: 2,
        title: 'Design Blog',
        category: { id: 20, title: '设计', user_id: 1, hide_globally: false }
      }),
      createFeed({
        id: 3,
        title: 'AI News',
        category: { id: 10, title: '技术', user_id: 1, hide_globally: false }
      })
    ])

    const { menuItems, hasFeeds } = useFeedNavigation(feeds)

    expect(hasFeeds.value).toBe(true)
    // 返回二维数组，第一组包含标签 + 分类菜单
    expect(menuItems.value).toHaveLength(1)
    const firstGroup = menuItems.value[0]!
    // 第一个是标签项，后面是两个分类
    expect(firstGroup).toHaveLength(3)
    expect(firstGroup[0]!.label).toBe('订阅源')
    expect(firstGroup[0]!.type).toBe('label')

    const techGroup = findGroup(menuItems.value, '技术')
    expect(techGroup.children).toHaveLength(2)
    expect(techGroup.children![0]!.label).toBe('Tech Blog')
    expect(techGroup.children![0]!.to).toBe('/feeds/1')
    expect(techGroup.children![1]!.label).toBe('AI News')
    expect(techGroup.children![1]!.to).toBe('/feeds/3')

    const designGroup = findGroup(menuItems.value, '设计')
    expect(designGroup.children).toHaveLength(1)
    expect(designGroup.children![0]!.label).toBe('Design Blog')
  })

  it('没有分类的feeds归入"未分类"组', () => {
    const feeds = computed(() => [
      createFeed({ id: 1, title: 'Orphan Feed' }),
      createFeed({
        id: 2,
        title: 'Categorized Feed',
        category: { id: 10, title: '技术', user_id: 1, hide_globally: false }
      })
    ])

    const { menuItems } = useFeedNavigation(feeds)

    const ungrouped = findGroup(menuItems.value, '未分类')
    expect(ungrouped.children).toHaveLength(1)
    expect(ungrouped.children![0]!.label).toBe('Orphan Feed')
    expect(ungrouped.children![0]!.to).toBe('/feeds/1')
  })

  it('所有feeds都没有分类时只显示"未分类"组', () => {
    const feeds = computed(() => [
      createFeed({ id: 1, title: 'Feed A' }),
      createFeed({ id: 2, title: 'Feed B' })
    ])

    const { menuItems, hasFeeds } = useFeedNavigation(feeds)

    expect(hasFeeds.value).toBe(true)
    expect(menuItems.value).toHaveLength(1)
    const firstGroup = menuItems.value[0]!
    expect(firstGroup).toHaveLength(2)
    expect(firstGroup[0]!.label).toBe('订阅源')
    expect(firstGroup[1]!.label).toBe('未分类')
    expect(firstGroup[1]!.children).toHaveLength(2)
  })

  it('category存在但id为undefined时归入未分类', () => {
    const feeds = computed(() => [
      createFeed({
        id: 1,
        title: 'No Category ID',
        category: { id: undefined as unknown as number, title: 'Broken', user_id: 1, hide_globally: false }
      })
    ])

    const { menuItems } = useFeedNavigation(feeds)

    const firstGroup = menuItems.value[0]!
    expect(firstGroup).toHaveLength(2)
    expect(firstGroup[1]!.label).toBe('未分类')
  })

  it('feeds响应式更新时menuItems同步更新', () => {
    const feedsRef = ref<Feed[] | null>(null)
    const feeds = computed(() => feedsRef.value)
    const { menuItems, hasFeeds } = useFeedNavigation(feeds)

    expect(hasFeeds.value).toBe(false)

    feedsRef.value = [
      createFeed({
        id: 1,
        title: 'New Feed',
        category: { id: 10, title: '技术', user_id: 1, hide_globally: false }
      })
    ]

    expect(hasFeeds.value).toBe(true)
    expect(menuItems.value).toHaveLength(1)
    const firstGroup = menuItems.value[0]!
    expect(firstGroup[1]!.label).toBe('技术')
    expect(firstGroup[1]!.children).toHaveLength(1)
  })

  it('分类菜单项包含folder图标', () => {
    const feeds = computed(() => [
      createFeed({
        id: 1,
        title: 'Feed A',
        category: { id: 10, title: '技术', user_id: 1, hide_globally: false }
      })
    ])

    const { menuItems } = useFeedNavigation(feeds)

    const techGroup = findGroup(menuItems.value, '技术')
    expect(techGroup.icon).toBe('i-lucide-folder')
  })
})
