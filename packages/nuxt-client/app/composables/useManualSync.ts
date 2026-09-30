import { ref, toValue } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 手动同步的结果：供调用方（如 SyncButton 的 `synced` 事件）判断这次同步到底做成了什么。
 *
 * added 是本轮真正写入本地的文档数，也是「有没有新条目」的判据：
 * 为 0 说明这次同步没带来任何新内容（多半是全部被增量过滤跳过、按钮瞬时完成）。
 * storageBroken 表示本轮被存储故障熔断，结果不完整，不可据此判断「没有新条目」。
 */
export interface ManualSyncOutcome {
  /** 本轮真正写入本地的文档数（0 = 这次同步没有带来新条目） */
  added: number
  /** 被增量过滤跳过（远端无更新）的目标数 */
  skipped: number
  /** 复制失败的目标数 */
  failed: number
  /** 被用户暂停中断的目标数 */
  cancelled: number
  /** 本地存储故障导致本轮熔断：结果不完整，调用方不应据此改列表 */
  storageBroken: boolean
}

/**
 * 手动同步：立即从远端拉取最新数据，并用 toast 反馈结果。
 *
 * 顶部工具栏的 SyncButton 与侧边栏的同步状态指示器共用这份逻辑，
 * 避免两处各写一份 toast 文案。不传 feedIds 时作用于所有已激活的库。
 *
 * 同步走增量：没有新内容的源会被跳过（见 syncNow），因此点击通常很快完成。
 * 同步途中用户点了「暂停同步」（左下角指示器）时，本轮剩余任务被取消：
 * 这里静默收尾，不弹失败提示 —— 暂停动作本身已有 toast 反馈。
 *
 * sync() 返回本轮结果；重入（上一轮还在跑）时返回 null —— 调用方据此知道
 * 「这一轮没真的执行」，不要拿它当同步结论。
 */
export function useManualSync(feedIds?: MaybeRefOrGetter<string[] | undefined>) {
  const pouch = usePouchDb()
  const toast = useToast()
  const syncing = ref(false)

  async function sync(): Promise<ManualSyncOutcome | null> {
    if (syncing.value) return null
    syncing.value = true
    try {
      const result = await pouch.syncNow(toValue(feedIds))
      const outcome: ManualSyncOutcome = {
        added: result.added,
        skipped: result.skipped,
        failed: result.failed.length,
        cancelled: result.cancelled,
        storageBroken: false
      }
      // 本地存储故障（配额耗尽 / 数据库损坏）：本轮已被熔断，剩余目标并没有真的尝试，
      // 此时报「N 个失败」没有意义，直接给出可操作的提示
      if (pouch.storageBroken.value) {
        toast.add({
          title: '本地缓存写入失败',
          description: pouch.storageBroken.value,
          color: 'error'
        })
        return { ...outcome, storageBroken: true }
      }
      // 用户中途暂停：本轮剩余目标已被取消，交给暂停的 toast，不在这里报「失败」
      if (result.cancelled > 0) return outcome
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
      return outcome
    } finally {
      syncing.value = false
    }
  }

  return { syncing, sync }
}
