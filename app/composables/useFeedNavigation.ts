import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { Feed } from '~/lib/miniflux/types'
import type { NavigationMenuItem } from '@nuxt/ui'

interface FeedNavigationReturn {
  menuItems: ComputedRef<NavigationMenuItem[][]>
  hasFeeds: ComputedRef<boolean>
}

export function useFeedNavigation(feeds: ComputedRef<Feed[] | null>): FeedNavigationReturn {
  const menuItems = computed<NavigationMenuItem[][]>(() => {
    if (!feeds.value) return []

    const categoryItems: NavigationMenuItem[] = []
    const groups = new Map<number, NavigationMenuItem[]>()
    const categoriesMap = new Map<number, { id: number, title: string }>()

    for (const feed of feeds.value) {
      const category = feed.category
      const categoryId = category?.id

      if (!categoryId || !category) continue

      if (!groups.has(categoryId)) {
        groups.set(categoryId, [])
        categoriesMap.set(categoryId, category)
      }

      groups.get(categoryId)!.push({
        label: feed.title,
        to: `/rss/feed/${feed.id}`
      })
    }

    // 每个分类作为可折叠父菜单，点击分类跳转 /rss/category/:id，children 为该分类下所有 feeds
    for (const [categoryId, children] of groups.entries()) {
      const category = categoriesMap.get(categoryId)!
      categoryItems.push({
        label: category.title,
        icon: 'i-lucide-folder',
        to: `/rss/category/${categoryId}`,
        children
      })
    }

    // 未分类的 feeds
    const ungrouped = feeds.value
      .filter(feed => !feed.category?.id)
      .map(feed => ({
        label: feed.title,
        to: `/rss/feed/${feed.id}`
      }))

    if (ungrouped.length > 0) {
      categoryItems.push({
        label: '未分类',
        icon: 'i-lucide-folder',
        children: ungrouped
      })
    }

    if (categoryItems.length === 0) return []

    return [
      [
        { label: '订阅源', type: 'label' },
        ...categoryItems
      ]
    ]
  })

  const hasFeeds = computed(() => {
    return menuItems.value.length > 0
  })

  return { menuItems, hasFeeds }
}
