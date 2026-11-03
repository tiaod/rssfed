import type { SubscriptionItem } from '~/types/rss'

/**
 * 判断两份订阅列表是否等价（顺序敏感）。
 *
 * 用途：侧边栏在 `subscriptionsVersion` 变化时重读订阅列表（见 FeedNavigation）。
 * 一个复制批次可能带进多条订阅文档，每次重读都会产生一份新数组；若不加比较就赋值，
 * `feeds.value` 会换成新数组 → `menuItems` 重算 → 整棵导航菜单重渲染
 * （300 项实测约 30ms），而其中有些批次的内容与当前列表完全相同。
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
