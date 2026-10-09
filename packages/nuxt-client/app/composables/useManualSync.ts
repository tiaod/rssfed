import { ref } from 'vue'
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
  /** 本地存储故障导致本轮熔断：结果不完整，调用方不应据此改列表 */
  storageBroken: boolean
}

/**
 * 手动同步：让服务端立刻聚合一轮，并把结果同步到本地，用 toast 反馈结果。
 *
 * 顶部工具栏的 SyncButton 与侧边栏的同步状态指示器共用这份逻辑，避免两处各写一份文案。
 *
 * 不再需要「同步哪些源」的参数：服务端按当前订阅集合一次聚合完（见 usePouchDb.syncNow）。
 * 服务端在这一轮请求内跑完（wait=1）是常见情况，因此点击通常几百毫秒就结束；
 * 若服务端超时（新订阅要回填大量历史），本轮按「仍在聚合」提示，数据随后由 live 复制到端。
 *
 * sync() 返回本轮结果；重入（上一轮还在跑）时返回 null —— 调用方据此知道
 * 「这一轮没真的执行」，不要拿它当同步结论。
 */
export function useManualSync() {
  const pouch = usePouchDb()
  const toast = useToast()
  const syncing = ref(false)

  async function sync(): Promise<ManualSyncOutcome | null> {
    if (syncing.value) return null
    syncing.value = true
    try {
      const result = await pouch.syncNow()
      const outcome: ManualSyncOutcome = {
        added: result.added,
        skipped: result.skipped,
        failed: result.failed.length,
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
      if (result.failed.length > 0) {
        toast.add({
          title: '同步失败',
          description: result.failed.map(f => f.error).join('；'),
          color: 'error'
        })
      } else if (result.serverPending) {
        // 服务端还在后台聚合（本轮请求超时）：不谎报「已是最新」，
        // 数据到端后由「已同步 N 条」提示条兜住。
        // 这一支必须排在「同步完成」之前：超时的响应同样算「已受理」，ok 里是有目标的
        toast.add({
          title: '服务端仍在聚合',
          description: '内容会在后台同步完成后自动出现',
          color: 'info'
        })
      } else if (result.ok.length > 0) {
        toast.add({
          title: '同步完成',
          ...(result.added > 0 ? { description: `新增 ${result.added} 条` } : {}),
          color: 'success'
        })
      } else {
        toast.add({ title: '已是最新', description: '订阅源都没有新内容', color: 'success' })
      }
      return outcome
    } finally {
      syncing.value = false
    }
  }

  return { syncing, sync }
}
