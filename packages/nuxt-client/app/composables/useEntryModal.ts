import type { RssEntry } from '~/types/rss'

/**
 * 条目详情模态弹窗的全局状态。
 *
 * 用模态替代独立路由页面，避免页面切换导致列表滚动状态丢失。
 * 状态通过 useState 在组件间共享，EntryList 触发 openEntry，
 * 在 layout 中全局渲染的 EntryDetailModal 监听 isOpen。
 */
export function useEntryModal() {
  const isOpen = useState<boolean>('entry-modal-open', () => false)
  const currentEntry = useState<RssEntry | null>('entry-modal-entry', () => null)

  function openEntry(entry: RssEntry) {
    currentEntry.value = entry
    isOpen.value = true
  }

  function closeEntry() {
    isOpen.value = false
  }

  return { isOpen, currentEntry, openEntry, closeEntry }
}
