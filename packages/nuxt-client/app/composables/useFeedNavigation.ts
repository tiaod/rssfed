import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { SubscriptionItem } from '~/types/rss'
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * 侧边栏菜单项：在 NavigationMenuItem 之上附加 FeedIcon 懒加载需要的字段。
 * UNavigationMenu 会忽略它不认识的属性，这些字段只被 `#feed-leading` 插槽消费。
 */
export interface FeedNavigationMenuItem extends NavigationMenuItem {
  /** 订阅业务 id（bot 订阅为 `bot:<botId>`）；分组/标签项没有 */
  feedId?: string
  /** 图标未就位时的首字母占位 */
  fallbackText?: string
  /** 自定义插槽名：feed 项固定为 'feed'，对应侧边栏里的 `#feed-leading` */
  slot?: string
}

export interface FeedNavigationOptions {
  /** 当前路由对应的订阅 id（`/rss/feed/:id`、`/bots/:id/posts`），用于默认展开所在分组 */
  activeFeedId?: ComputedRef<string | null>
  /** 当前路由对应的分类（`/rss/group/:category`），用于默认展开该分组 */
  activeCategory?: ComputedRef<string | null>
}

/** 分组项在 UNavigationMenu 里的值：同时作为受控展开状态的键 */
export function categoryGroupValue(category: string): string {
  return `cat:${category}`
}

/**
 * 生成侧边栏导航菜单。
 *
 * 图标不在这里批量加载 —— 由 FeedNavigation 的 `#feed-leading` 插槽渲染 FeedIcon，
 * 按可见性懒加载（几百个源时一次性读取图标附件会占满主线程）。
 *
 * 分组默认**只展开当前路由所在的那个**：几百个订阅源全部展开意味着几百个菜单项同时
 * 进 DOM（实测 433 项约 120–150ms 的组件创建 + 布局成本），而用户一眼能看的只有十几个。
 * 其余分组保持折叠，由用户点击展开。
 */
export function useFeedNavigation(
  feeds: ComputedRef<SubscriptionItem[] | null>,
  options: FeedNavigationOptions = {}
) {
  const menuItems = computed<FeedNavigationMenuItem[][]>(() => {
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

    /** 菜单项公共字段：图标交给 FeedIcon（见 slot 标记），这里只留文字占位信息 */
    const itemFor = (feed: SubscriptionItem): FeedNavigationMenuItem => {
      // bot 订阅（id 形如 `bot:{botId}`）链接到 bot 产出页，普通 feed 链接到源页
      const to = feed.kind === 'bot'
        ? `/bots/${feed.id.slice('bot:'.length)}/posts`
        : `/rss/feed/${feed.id}`
      return {
        label: feed.title,
        to,
        slot: 'feed',
        feedId: feed.id,
        fallbackText: feed.title?.trim()[0] ?? 'R'
      }
    }

    const sections: FeedNavigationMenuItem[] = [{ label: '订阅源', type: 'label' }]
    const activeFeedId = options.activeFeedId?.value ?? null
    const activeCategory = options.activeCategory?.value ?? null

    for (const cat of sortedCats) {
      const items = groups.get(cat)!
      if (!cat) {
        // 未分类的直接展开为顶层项（无法折叠，数量由数据决定）
        for (const feed of items) {
          sections.push(itemFor(feed))
        }
      } else {
        // 有分类的作为可折叠分组：点击分组名跳转到聚合条目页，点击箭头展开/收起
        sections.push({
          label: cat,
          // value 同时用作受控展开状态的键（侧边栏用 v-model 控制展开哪些分组）
          value: categoryGroupValue(cat),
          defaultOpen: cat === activeCategory || items.some(i => i.id === activeFeedId),
          to: `/rss/group/${encodeURIComponent(cat)}`,
          children: items.map(itemFor)
        })
      }
    }

    return [sections]
  })

  const hasFeeds = computed(() => {
    return menuItems.value.length > 0
  })

  /**
   * 当前路由所在分组的 value（没有则为 null）。
   * 侧边栏用它把自己的受控展开状态对齐到当前页面 —— 否则从时间线点进某个源时，
   * 该源所在分组是折叠的，用户看不到当前所在位置。
   */
  const activeCategoryGroupValue = computed<string | null>(() => {
    const activeCategory = options.activeCategory?.value
    if (activeCategory) return categoryGroupValue(activeCategory)
    const activeFeedId = options.activeFeedId?.value
    if (!activeFeedId || !feeds.value) return null
    const hit = feeds.value.find(f => f.id === activeFeedId)
    const cat = hit?.category?.trim()
    return cat ? categoryGroupValue(cat) : null
  })

  return { menuItems, hasFeeds, activeCategoryGroupValue }
}
