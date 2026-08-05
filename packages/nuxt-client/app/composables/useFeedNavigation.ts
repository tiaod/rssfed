import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { SubscriptionItem } from '~/composables/useCouchDb'
import type { NavigationMenuItem } from '@nuxt/ui'

export function useFeedNavigation(feeds: ComputedRef<SubscriptionItem[] | null>) {
  const menuItems = computed<NavigationMenuItem[][]>(() => {
    if (!feeds.value || feeds.value.length === 0) return []

    // 按分类分组
    const groups = new Map<string, SubscriptionItem[]>()
    for (const feed of feeds.value) {
      const cat = feed.category?.trim() || ''
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(feed)
    }

    // 排序：有分类的按名称排序，未分类排最后
    const sortedCats = [...groups.keys()].sort((a, b) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b, 'zh-CN')
    })

    const sections: NavigationMenuItem[] = [{ label: '订阅源', type: 'label' }]

    for (const cat of sortedCats) {
      const items = groups.get(cat)!
      if (!cat) {
        // 未分类的直接展开为顶层项
        for (const feed of items) {
          sections.push({ label: feed.title, to: `/rss/feed/${feed.id}` })
        }
      } else {
        // 有分类的作为可折叠分组：点击分组名跳转到聚合条目页，点击箭头展开/收起
        sections.push({
          label: cat,
          defaultOpen: true,
          to: `/rss/group/${encodeURIComponent(cat)}`,
          children: items.map(feed => ({
            label: feed.title,
            to: `/rss/feed/${feed.id}`,
          })),
        })
      }
    }

    return [sections]
  })

  const hasFeeds = computed(() => {
    return menuItems.value.length > 0
  })

  return { menuItems, hasFeeds }
}
