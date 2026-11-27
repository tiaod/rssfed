/**
 * 定时维护任务：休眠用户暂停 + 每 (owner × 源) 的自适应保留条数。
 *
 * 这些任务都挂在服务进程的 setInterval 上（和抓取调度同一种做法），不占 BullMQ 队列：
 * 它们的工作量由 owner 数量决定、周期长（小时/天级），放进队列反而会让"每 owner 一个 job"
 * 把队列刷满。测试进程不挂（否则 `vitest --watch` 挂着时也会往真实 PG/CouchDB 上跑清理）。
 *
 * 与旧版的差别：**源库墓碑 GC 与孤儿源清扫都已删除**。没有共享源库，就没有"零订阅的源还在
 * 被抓"这回事 —— 每个 owner 只抓自己订阅的东西，退订即停止。
 */
import { envInt } from "../env"
import { collectScheduleTargets, pauseDormantOwners, recomputeOwnerRetention } from "../services/owner-platform"

const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

/** 自适应保留条数：按 (owner × 源) 的活跃度每天重算一次 N */
const RETENTION_ENABLED = process.env.FEED_RETENTION_ADAPTIVE !== "0"
const RETENTION_INITIAL_DELAY_MS = envInt("FEED_RETENTION_INITIAL_DELAY_MS", 600_000, { min: 0 })
const RETENTION_INTERVAL_MS = envInt("FEED_RETENTION_INTERVAL_MS", 86_400_000, { min: 3_600_000 })

/** 多少天没活动算休眠（0 / 负数 = 关闭） */
const DORMANT_DAYS = envInt("TIMELINE_DORMANT_DAYS", 90, { min: 0, max: 3650 })
const DORMANT_SCAN_INTERVAL_MS = envInt("TIMELINE_DORMANT_SCAN_INTERVAL_MS", 86_400_000, { min: 300_000 })

/**
 * 每轮最多处理多少个 owner 的保留条数。
 *
 * 一天一轮、每 owner 一次 view 查询（与库大小无关），这个上限只是防止首次上线时
 * 一口气扫几千个库把 CouchDB 打满；没轮到的下一轮继续。
 */
const RETENTION_MAX_OWNERS = envInt("FEED_RETENTION_MAX_OWNERS", 200, { min: 1 })

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
    const paused = await pauseDormantOwners(DORMANT_DAYS)
    if (paused.length > 0) {
      console.log(`[Timeline] 休眠暂停：${paused.length} 个用户超过 ${DORMANT_DAYS} 天未活动，已停止抓取`)
    }
  } catch (err) {
    console.error("[Timeline] 休眠判定失败（下一轮继续）：", (err as Error)?.message ?? err)
  } finally {
    dormantRunning = false
  }
}

/** 跑一轮自适应保留条数；导出给脚本/测试手动调用（不经过定时器） */
export async function runAdaptiveRetentionScheduled(): Promise<void> {
  if (retentionRunning) {
    console.warn("[FeedRetention] 上一轮还没跑完，跳过本轮")
    return
  }
  retentionRunning = true
  const startedAt = Date.now()
  let owners = 0
  let changed = 0
  let trimmed = 0
  let failures = 0

  try {
    const targets = await collectScheduleTargets()
    const limited = targets.filter((target) => !target.paused).slice(0, RETENTION_MAX_OWNERS)
    for (const target of limited) {
      try {
        const result = await recomputeOwnerRetention(target.dbName)
        owners += 1
        changed += result.changed
        trimmed += result.trimmed
      } catch (err) {
        failures += 1
        console.warn(`[FeedRetention] ${target.owner.kind}=${target.owner.id} 计算失败：${(err as Error)?.message ?? err}`)
      }
    }
    if (owners > 0) {
      console.log(
        `[FeedRetention] 处理 ${owners} 个 owner，调整 ${changed} 个源的 N，裁剪 ${trimmed} 条，`
        + `失败 ${failures}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`,
      )
    }
  } catch (err) {
    console.error("[FeedRetention] 本轮失败（下一轮继续）：", (err as Error)?.message ?? err)
  } finally {
    retentionRunning = false
  }
}

export function startTimelineMaintenance(): void {
  if (isTestProcess) return

  dormantInterval = setInterval(() => { void pauseDormantUsersScheduled() }, DORMANT_SCAN_INTERVAL_MS)
  dormantInterval.unref?.()

  if (RETENTION_ENABLED) {
    retentionInitialTimer = setTimeout(() => { void runAdaptiveRetentionScheduled() }, RETENTION_INITIAL_DELAY_MS)
    retentionInitialTimer.unref?.()
    retentionInterval = setInterval(() => { void runAdaptiveRetentionScheduled() }, RETENTION_INTERVAL_MS)
    retentionInterval.unref?.()
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
