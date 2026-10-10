import { ref } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 手动同步的结果：供调用方（如 SyncButton 的 `synced` 事件）判断这次同步到底做成了什么。
 *
 * added 是**本轮针对调用方范围**真正写入本地的条目数，也是「有没有新条目」的判据：
 * 为 0 说明这次同步没给这个列表带来任何新内容（多半是全部被增量过滤跳过、按钮瞬时完成）。
 * 带 scope 调用时（单源 / 分组 / bot 页）只算范围里的源 —— 别的源新增不会让本页以为
 * 「有新内容」，也不会把它算进 toast 的条数。
 *
 * storageBroken 表示本轮被存储故障熔断，结果不完整，不可据此判断「没有新条目」。
 */
export interface ManualSyncOutcome {
  /** 本轮真正写入本地的条目数（调用方给了 scope 时只算范围里的源；0 = 没有新条目） */
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
 * 不再需要「同步哪些源」来决定同步范围：服务端按当前订阅集合一次聚合完（见 usePouchDb.syncNow）。
 * 服务端在这一轮请求内跑完（wait=1）是常见情况，因此点击通常几百毫秒就结束；
 * 若服务端超时（新订阅要回填大量历史），本轮按「仍在聚合」提示，数据随后由 live 复制到端。
 *
 * `scope` 只影响**反馈口径**，不影响同步本身（聚合永远是全部订阅）：单源 / 分组 / bot 页
 * 传自己列表的 feedId，toast 与 outcome.added 就报这个列表多了几条；侧边栏那个全局同步
 * 不传，报全库。不这样做的话，在单源页点同步会因为别的源有更新而显示「新增 N 条」，
 * 而这个列表一条都没多。
 *
 * sync() 返回本轮结果；重入（上一轮还在跑）时返回 null —— 调用方据此知道
 * 「这一轮没真的执行」，不要拿它当同步结论。
 */
export function useManualSync() {
  const pouch = usePouchDb()
  const toast = useToast()
  const syncing = ref(false)

  async function sync(scope?: readonly string[]): Promise<ManualSyncOutcome | null> {
    if (syncing.value) return null
    syncing.value = true
    try {
      const result = await pouch.syncNow()
      // 有 scope 就按范围求和（本地实测的按源记账），没 scope 用服务端/本地的全库条数
      const added = scope
        ? scope.reduce((sum, feedId) => sum + (result.addedByFeed[feedId] ?? 0), 0)
        : result.added
      const outcome: ManualSyncOutcome = {
        added,
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
        // 范围口径下「本轮确实有新内容，但不在这个列表里」也要说清：否则菜单项点下去只看到
        // 一句「同步完成」，列表纹丝不动，用户会以为同步没生效
        const description = added > 0
          ? `新增 ${added} 条`
          : scope && result.added > 0 ? '本列表没有新条目' : undefined
        toast.add({
          title: '同步完成',
          ...(description ? { description } : {}),
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
