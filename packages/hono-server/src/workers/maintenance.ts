/**
 * 定时维护任务：休眠用户暂停 + 源库自适应保留条数。
 *
 * **源库墓碑 GC 已随 selector 汇聚一起删除**：新方案两侧都用 `_purge` 做保留
 * （见 `couchdb/retention.ts`），库里不再产生墓碑，GC 也就没有对象了。
 *
 * 这些任务都挂在服务进程的 setInterval 上（和抓取/聚合调度同一种做法），不占 BullMQ 队列：
 * 它们的工作量由库数量决定、周期长（小时/天级），放进队列反而会让"每源一个 job"把队列刷满。
 * 测试进程不挂（否则 `vitest --watch` 挂着时也会往真实 PG/CouchDB 上跑清理）。
 */
import { envInt, formatDuration } from "../env"
import { pauseDormantUsers } from "../services/timeline-lifecycle"
import { readAdaptiveRetentionConfig, runAdaptiveRetention } from "../services/feed-retention"

const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

/** 自适应保留条数：按源活跃度每天重算一次 N（见 services/feed-retention.ts） */
const RETENTION_ENABLED = process.env.FEED_RETENTION_ADAPTIVE !== "0"
const RETENTION_INITIAL_DELAY_MS = envInt("FEED_RETENTION_INITIAL_DELAY_MS", 600_000, { min: 0 })
const RETENTION_INTERVAL_MS = envInt("FEED_RETENTION_INTERVAL_MS", 86_400_000, { min: 3_600_000 })

/** 多少天没活动算休眠（0 / 负数 = 关闭） */
const DORMANT_DAYS = envInt("TIMELINE_DORMANT_DAYS", 90, { min: 0, max: 3650 })
const DORMANT_SCAN_INTERVAL_MS = envInt("TIMELINE_DORMANT_SCAN_INTERVAL_MS", 86_400_000, { min: 300_000 })

let dormantInterval: ReturnType<typeof setInterval> | null = null
let retentionInterval: ReturnType<typeof setInterval> | null = null
let retentionInitialTimer: ReturnType<typeof setTimeout> | null = null
/** 上一轮还没跑完就不叠第二轮（一轮要扫几百个库，可能超过间隔） */
let dormantRunning = false
let retentionRunning = false

/** 跑一轮休眠判定；导出给脚本/测试手动调用 */
export async function pauseDormantUsersScheduled(): Promise<void> {
  if (DORMANT_DAYS <= 0) return
  if (dormantRunning) return
  dormantRunning = true
  try {
    const paused = await pauseDormantUsers(DORMANT_DAYS)
    if (paused.length > 0) {
      console.log(`[Timeline] 休眠暂停：${paused.length} 个用户超过 ${DORMANT_DAYS} 天未活动，已停止聚合（回来时重建）`)
    }
  } catch (err) {
    console.error("[Timeline] 休眠判定失败（下一轮继续）：", (err as Error)?.message ?? err)
  } finally {
    dormantRunning = false
  }
}

/** 跑一轮源库自适应保留条数；导出给脚本/测试手动调用（不经过定时器） */
export async function runAdaptiveRetentionScheduled(): Promise<void> {
  if (retentionRunning) {
    console.warn("[FeedRetention] 上一轮还没跑完，跳过本轮")
    return
  }
  retentionRunning = true
  try {
    const stats = await runAdaptiveRetention(readAdaptiveRetentionConfig())
    const changed = stats.changed > 0 ? `变档=${stats.changed}（收紧=${stats.shrunk}）` : "无变档"
    console.log(
      `[FeedRetention] 源=${stats.feeds} ${changed} 裁掉=${stats.trimmed} `
      + `跳过=${stats.skipped} 失败=${stats.errors.length} 用时=${formatDuration(stats.elapsedMs)}`,
    )
    for (const failure of stats.errors.slice(0, 5)) {
      console.warn(`[FeedRetention] 源 ${failure.feedId} 计算失败：${failure.error}`)
    }
  } catch (err) {
    // 整体失败（PG/CouchDB 不可用等）不能让进程挂；下一轮继续
    console.error("[FeedRetention] 本轮失败（下一轮继续）：", (err as Error)?.message ?? err)
  } finally {
    retentionRunning = false
  }
}

/** 服务启动时调用一次，挂上定时器（测试进程不挂） */
export function startTimelineMaintenance(): void {
  if (isTestProcess) return

  if (RETENTION_ENABLED) {
    console.log(
      `[FeedRetention] 已启用：每 ${formatDuration(RETENTION_INTERVAL_MS)} 一轮，`
      + `启动后 ${formatDuration(RETENTION_INITIAL_DELAY_MS)} 首轮`,
    )
    retentionInitialTimer = setTimeout(() => {
      void runAdaptiveRetentionScheduled()
    }, RETENTION_INITIAL_DELAY_MS)
    retentionInterval = setInterval(() => {
      void runAdaptiveRetentionScheduled()
    }, RETENTION_INTERVAL_MS)
    retentionInitialTimer.unref?.()
    retentionInterval.unref?.()
  } else {
    console.log("[FeedRetention] 已禁用（FEED_RETENTION_ADAPTIVE=0）")
  }

  if (DORMANT_DAYS > 0) {
    console.log(`[Timeline] 休眠暂停已启用：超过 ${DORMANT_DAYS} 天未活动停止聚合，每天扫描一次`)
    dormantInterval = setInterval(() => {
      void pauseDormantUsersScheduled()
    }, DORMANT_SCAN_INTERVAL_MS)
    dormantInterval.unref?.()
    // 启动 10 分钟后再做首次判定（避开启动高峰；不影响正确性）
    const initial = setTimeout(() => {
      void pauseDormantUsersScheduled()
    }, 600_000)
    initial.unref?.()
  }
}

export function shutdownTimelineMaintenance(): void {
  if (dormantInterval) clearInterval(dormantInterval)
  if (retentionInterval) clearInterval(retentionInterval)
  if (retentionInitialTimer) clearTimeout(retentionInitialTimer)
  dormantInterval = null
  retentionInterval = null
  retentionInitialTimer = null
}
