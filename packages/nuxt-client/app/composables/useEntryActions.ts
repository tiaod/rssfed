import { ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { errorMessage } from '~/utils/errorMessage'

/**
 * 单条条目的就地动作：标为已读 / 未读、收藏。
 *
 * 详情工具栏（useEntryDetail）与信息流条目的操作栏（EntrySocialItem）做的是同一件事：
 * 写用户状态库的 entry-state 文档，再把结果就地写回**传入的那个条目对象** —— 它通常就是
 * 列表数组里的元素，共用引用，界面立刻淡显 / 换圆点，不必重查列表。口径只在这里写一份，
 * 两个调用方各自只负责按钮版式。
 *
 * 用取值函数而不是直接传对象：详情面的条目翻页时会换（`currentEntry` 是 ref），
 * 取值函数每次都读到当下那一条；信息流条目则一直指向列表里的自己。
 */
export function useEntryActions(getEntry: () => RssEntry | null | undefined) {
  const pouch = usePouchDb()
  const toast = useToast()

  const readBusy = ref(false)
  const savedBusy = ref(false)

  /** 切换已读 / 未读。与详情的「打开即已读」共用同一个开关，并发冲突由 markRead 内部重试消化 */
  async function toggleRead() {
    const entry = getEntry()
    if (!entry || readBusy.value) return
    const next = !entry.read
    readBusy.value = true
    try {
      await pouch.markRead(entry.id, entry.feedId, next)
      entry.read = next
    } catch (e: unknown) {
      toast.add({ title: '操作失败', description: errorMessage(e, '标记已读失败'), color: 'error' })
    } finally {
      readBusy.value = false
    }
  }

  /** 收藏 / 取消收藏。切换后的值以本地库返回为准，避免两端状态不一致 */
  async function toggleStar() {
    const entry = getEntry()
    if (!entry || savedBusy.value) return
    savedBusy.value = true
    try {
      entry.starred = await pouch.toggleSaved(entry.id, entry.feedId)
    } catch (e: unknown) {
      toast.add({ title: '操作失败', description: errorMessage(e, '收藏失败'), color: 'error' })
    } finally {
      savedBusy.value = false
    }
  }

  return { readBusy, savedBusy, toggleRead, toggleStar }
}
