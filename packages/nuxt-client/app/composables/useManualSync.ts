import { ref, toValue } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

/**
 * 手动同步：立即从远端拉取最新数据，并用 toast 反馈结果。
 *
 * 顶部工具栏的 SyncButton 与侧边栏的同步状态指示器共用这份逻辑，
 * 避免两处各写一份 toast 文案。不传 feedIds 时作用于所有已激活的库。
 *
 * 同步走增量：没有新内容的源会被跳过（见 syncNow），因此点击通常很快完成。
 * 同步途中用户点了「暂停同步」（左下角指示器）时，本轮剩余任务被取消：
 * 这里静默收尾，不弹失败提示 —— 暂停动作本身已有 toast 反馈。
 */
export function useManualSync(feedIds?: MaybeRefOrGetter<string[] | undefined>) {
  const pouch = usePouchDb()
  const toast = useToast()
  const syncing = ref(false)

  async function sync() {
    if (syncing.value) return
    syncing.value = true
    try {
      const result = await pouch.syncNow(toValue(feedIds))
      // 用户中途暂停：本轮剩余目标已被取消，交给暂停的 toast，不在这里报「失败」
      if (result.cancelled > 0) return
      if (result.failed.length > 0) {
        toast.add({
          title: '同步失败',
          description: result.failed.map(f => f.error).join('；'),
          color: 'error'
        })
      } else if (result.ok.length > 0) {
        toast.add({
          title: '同步完成',
          // 被增量过滤跳过的源也报出来，避免「点了一下没反应」的困惑
          description: result.skipped > 0 ? `另有 ${result.skipped} 个订阅源无更新，已跳过` : undefined,
          color: 'success'
        })
      } else {
        toast.add({ title: '已是最新', description: '所选订阅源都没有新内容', color: 'success' })
      }
    } finally {
      syncing.value = false
    }
  }

  return { syncing, sync }
}
