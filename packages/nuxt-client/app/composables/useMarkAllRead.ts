import type { ComputedRef, Ref } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'
import { errorMessage } from '~/utils/errorMessage'
import type { RssEntry } from '~/types/rss'

export interface MarkAllReadOptions {
  /**
   * 标记成功之后接着做什么。
   *
   * 「只看未读」下用它走一次刷新（见 useUnreadFilter.refreshUnread）：那是明确的
   * 「这批我看完了」的动作，标完就该把位置让给后面还没读的；不传则维持「就地改状态、
   * 不重查列表」—— 显示全部时列表里已读条目本来就该留着。
   */
  afterMark?: () => unknown
}

/**
 * 列表页的「全部标记为已读」。
 *
 * 只处理**当前列表里已加载的**条目（页尾「查看」之前就这些）：不做「该源全部历史」——
 * 那要先全量查询再批量写，一个老源上千条文档，写入和随后的同步都会明显卡一下，
 * 而用户此刻看得见的就是这一屏。将来若要做全量，入口应该放在订阅管理里而不是列表按钮。
 *
 * 写完直接把本地条目的 read 置真，**不重查列表**：重查会把滚动位置带回顶部，
 * 而用户刚点的只是「标已读」，没有理由动他的位置。唯一的例外是 `afterMark`（未读模式下
 * 标完刷新），那时位置本来就该重置 —— 列表换了一批内容。
 *
 * 传进来的通常不是原始列表而是「只看未读」过滤后的可见列表（见 useUnreadFilter）：
 * 确认浮层里的条数、实际写入的范围都跟用户此刻看到的一致。
 */
export function useMarkAllRead(
  entries: Ref<RssEntry[]> | ComputedRef<RssEntry[]>,
  options: MarkAllReadOptions = {}
) {
  const pouch = usePouchDb()
  const toast = useToast()

  return async function markAllRead() {
    const targets = entries.value.map(entry => ({ id: entry.id, feedId: entry.feedId }))
    if (!targets.length) return
    try {
      const written = await pouch.markManyRead(targets)
      for (const entry of entries.value) entry.read = true
      toast.add({
        title: written ? `已将 ${written} 条标记为已读` : '这些条目已经是已读状态',
        color: 'success'
      })
      await options.afterMark?.()
    } catch (e: unknown) {
      toast.add({ title: '标记失败', description: errorMessage(e), color: 'error' })
    }
  }
}
