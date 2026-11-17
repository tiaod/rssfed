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
import { resumeSubscribedAutoPaused } from "../services/feed-orphans"
import { orphanPolicy, sweepOrphanFeeds } from "../services/feed-orphan-sweep"

const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

/** 自适应保留条数：按源活跃度每天重算一次 N（见 services/feed-retention.ts） */
const RETENTION_ENABLED = process.env.FEED_RETENTION_ADAPTIVE !== "0"
const RETENTION_INITIAL_DELAY_MS = envInt("FEED_RETENTION_INITIAL_DELAY_MS", 600_000, { min: 0 })
const RETENTION_INTERVAL_MS = envInt("FEED_RETENTION_INTERVAL_MS", 86_400_000, { min: 3_600_000 })

/** 多少天没活动算休眠（0 / 负数 = 关闭） */
const DORMANT_DAYS = envInt("TIMELINE_DORMANT_DAYS", 90, { min: 0, max: 3650 })
const DORMANT_SCAN_INTERVAL_MS = envInt("TIMELINE_DORMANT_SCAN_INTERVAL_MS", 86_400_000, { min: 300_000 })

/**
 * 孤儿源自动恢复的扫描周期。
 *
 * 只做**恢复**、不做暂停：暂停是破坏性的（会让一个源停止抓取），必须由管理员在后台
 * 明确点一次（`POST /api/feeds/orphans/pause`）。恢复是安全的（最多多抓一个源），
 * 所以挂定时器兜底 —— 订阅不一定走 API：客户端离线同步的订阅文档不会经过
 * addSubscriptionIfAbsent，也就不会触发即时恢复。
 */
const ORPHAN_RESUME_INTERVAL_MS = envInt("FEED_ORPHAN_RESUME_INTERVAL_MS", 3_600_000, { min: 300_000 })

/**
 * 孤儿源自动清理的扫描周期（默认 6 小时）。
 *
 * 一天跑几轮而不是一天一轮：每轮只处理 BATCH_LIMIT 条，跑得勤一点才能把积压消化掉，
 * 又不会因为一次全量处理把 DB 打满。真正的门槛是 orphanSince 上的天数，不是扫描频率。
 */
const ORPHAN_SWEEP_INTERVAL_MS = envInt("FEED_ORPHAN_SWEEP_INTERVAL_MS", 21_600_000, { min: 600_000 })

let dormantInterval: ReturnType<typeof setInterval> | null = null
let orphanResumeInterval: ReturnType<typeof setInterval> | null = null
let orphanSweepInterval: ReturnType<typeof setInterval> | null = null
/** 上一轮没跑完就不叠下一轮（一轮要扫所有用户库） */
let orphanSweepRunning = false
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

  // 孤儿源恢复：被自动暂停的源一旦有人重新订阅就开回来（有人订阅也可能来自客户端离线同步，
  // 那条路径不经过 API 的即时恢复，所以要有定时兜底）
  console.log(`[FeedOrphans] 自动恢复扫描已启用：每 ${formatDuration(ORPHAN_RESUME_INTERVAL_MS)} 一轮`)
  orphanResumeInterval = setInterval(() => {
    void resumeSubscribedAutoPaused()
      .then((n) => { if (n > 0) console.log(`[FeedOrphans] 恢复了 ${n} 个重新有人订阅的源`) })
      .catch((err) => {
        console.error("[FeedOrphans] 恢复扫描失败（下一轮继续）：", (err as Error)?.message ?? err)
      })
  }, ORPHAN_RESUME_INTERVAL_MS)
  orphanResumeInterval.unref?.()

  // 孤儿源自动清理：标记 → 冷静期后暂停 → 再一段冷静期后删除。
  // 门槛看的是 orphanSince 上的天数，所以这个频率只影响"多久检查一次"，不影响语义。
  const policy = orphanPolicy()
  if (policy.enabled) {
    const describe = [
      policy.pauseAfterDays > 0 ? `零订阅满 ${policy.pauseAfterDays} 天暂停` : "不自动暂停",
      policy.deleteAfterDays > 0 ? `暂停满 ${policy.deleteAfterDays} 天删除` : "永不自动删除",
    ].join("，")
    console.log(`[FeedOrphans] 自动清理已启用（${describe}）：每 ${formatDuration(ORPHAN_SWEEP_INTERVAL_MS)} 扫描一轮`)
    orphanSweepInterval = setInterval(() => {
      if (orphanSweepRunning) return
      orphanSweepRunning = true
      void sweepOrphanFeeds()
        .then((r) => {
          if (r.aborted) {
            console.warn(`[FeedOrphans] 本轮跳过：${r.reason}`)
            return
          }
          if (r.marked || r.cleared || r.paused || r.deleted) {
            console.log(
              `[FeedOrphans] 标记=${r.marked} 清除=${r.cleared} `
              + `暂停=${r.paused} 删除=${r.deleted} 跳过=${r.skipped}`,
            )
          }
        })
        .catch((err) => {
          console.error("[FeedOrphans] 自动清理失败（下一轮继续）：", (err as Error)?.message ?? err)
        })
        .finally(() => { orphanSweepRunning = false })
    }, ORPHAN_SWEEP_INTERVAL_MS)
    orphanSweepInterval.unref?.()
  } else {
    console.log("[FeedOrphans] 自动清理已禁用（两个天数都是 0）")
  }
}

export function shutdownTimelineMaintenance(): void {
  if (dormantInterval) clearInterval(dormantInterval)
  if (orphanResumeInterval) clearInterval(orphanResumeInterval)
  if (orphanSweepInterval) clearInterval(orphanSweepInterval)
  if (retentionInterval) clearInterval(retentionInterval)
  if (retentionInitialTimer) clearTimeout(retentionInitialTimer)
  dormantInterval = null
  orphanResumeInterval = null
  orphanSweepInterval = null
  retentionInterval = null
  retentionInitialTimer = null
}
