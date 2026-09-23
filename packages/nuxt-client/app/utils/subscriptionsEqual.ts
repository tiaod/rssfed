import type { SubscriptionItem } from '~/types/rss'

/**
 * 判断两份订阅列表是否等价（顺序敏感）。
 *
 * 用途：user-state 库同时承载「订阅」与「已读/收藏」，任何一次标记已读都会让
 * `syncStatuses['__user_state__'].version` 递增，进而触发侧边栏重新加载。
 * 若不加比较就赋值，`feeds.value` 会换成新数组 → `menuItems` 重算 →
 * 整棵导航菜单重渲染（300 项实测约 30ms），而这类触发绝大多数与订阅无关。
 *
 * 只比较侧边栏渲染用得到的字段：订阅项的新增/删除/改名/改分类/feed↔bot 类型切换。
 * `siteUrl`/`description`/`image`/`createdAt` 不影响侧边栏展示，订阅图标由
 * FeedDoc（集中条目库）提供，因此不参与比较 —— 让它们触发整棵树重渲染是白开销。
 */
export function subscriptionsEqual(
  a: readonly SubscriptionItem[] | null,
  b: readonly SubscriptionItem[]
): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.id !== y.id
      || x.title !== y.title
      || x.category !== y.category
      || x.kind !== y.kind
    ) {
      return false
    }
  }
  return true
}
