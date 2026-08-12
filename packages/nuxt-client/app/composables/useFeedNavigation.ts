import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { SubscriptionItem } from '~/composables/useCouchDb'
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * 生成侧边栏导航菜单。
 * @param icons feedId → 图标 URL（本地缓存 blob 优先），用于菜单项 avatar
 */
export function useFeedNavigation(
  feeds: ComputedRef<SubscriptionItem[] | null>,
  icons?: ComputedRef<Record<string, string>>,
) {
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

    /** 菜单项公共字段：feed 图标（有缓存/URL 显示图片，否则文字首字母占位） */
    const itemFor = (feed: SubscriptionItem) => {
      const src = icons?.value?.[feed.id]
      return {
        label: feed.title,
        to: `/rss/feed/${feed.id}`,
        // 尺寸由 UNavigationMenu 的 linkLeadingAvatarSize 控制（默认 sm）
        avatar: src
          ? { src }
          : { text: feed.title?.trim()[0] ?? 'R', color: 'neutral' as const },
      }
    }

    const sections: NavigationMenuItem[] = [{ label: '订阅源', type: 'label' }]

    for (const cat of sortedCats) {
      const items = groups.get(cat)!
      if (!cat) {
        // 未分类的直接展开为顶层项
        for (const feed of items) {
          sections.push(itemFor(feed))
        }
      } else {
        // 有分类的作为可折叠分组：点击分组名跳转到聚合条目页，点击箭头展开/收起
        sections.push({
          label: cat,
          defaultOpen: true,
          to: `/rss/group/${encodeURIComponent(cat)}`,
          children: items.map(itemFor),
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
