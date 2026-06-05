import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { RssFeed } from '~/types/rss'
import type { NavigationMenuItem } from '@nuxt/ui'

export function useFeedNavigation(feeds: ComputedRef<RssFeed[] | null>) {
  const menuItems = computed<NavigationMenuItem[][]>(() => {
    if (!feeds.value) return []

    const items: NavigationMenuItem[] = feeds.value.map(feed => ({
      label: feed.title,
      to: `/rss/feed/${feed.id}`
    }))

    if (items.length === 0) return []

    return [
      [
        { label: '订阅源', type: 'label' },
        ...items
      ]
    ]
  })

  const hasFeeds = computed(() => {
    return menuItems.value.length > 0
  })

  return { menuItems, hasFeeds }
}
