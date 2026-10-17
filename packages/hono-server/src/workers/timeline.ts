import { Queue, Worker } from "bullmq"
import { connection, createWorkerConnection } from "./connection"
import { enqueueSourceSyncs, shutdownSourceSyncWorker } from "./timeline-sync"
import { listSubscriberUserIds, listUserIds, rebuildUserTimeline, reconcileUserTimeline } from "../services/timeline"

/**
 * 用户时间线聚合队列（**拓扑对齐**，不是搬运本身）。
 *
 * 与抓取队列分开的理由：抓取的并发与超时特性完全不同（网络抓取、每源一个 job），
 * 聚合是「一个用户一个长事务」，混在一个队列里会让抓取被聚合堵住。
 *
 * **搬运在另一个队列**（`rss-timeline-sync`，见 ./timeline-sync.ts）：这里的 job 只算出
 * "哪些源脏了"，然后按需把每个源入队。分开是为了让并发按需限流 —— 拓扑对齐并发 1 ，
 * 而单源搬运必须有几个并发才不会让 600 个源串行搬十几分钟。
 *
 * jobId 直接用 userId（BullMQ 的 jobId 不允许含冒号），于是同一个用户的聚合请求天然去重：
 * 定时任务、客户端刷新、抓取完成通知三方同时打过来也只会有一个在跑。
 */
export const timelineQueue = new Queue("rss-timeline", { connection })

/** 入队一次用户聚合（同一用户已有排队/执行中的 job 时直接复用） */
export async function enqueueTimelineReconcile(userId: string, options: { force?: boolean } = {}): Promise<void> {
  const existing = await timelineQueue.getJob(userId)
  if (existing) {
    const state = await existing.getState()
    // 已结束的旧 job 必须先清掉，否则 jobId 会被 BullMQ 判定为重复而拒绝新 job
    if (state === "completed" || state === "failed") await existing.remove()
    else return
  }
  await timelineQueue.add("reconcile", { userId, force: options.force === true }, {
    jobId: userId,
    // 保留少量历史供看板（/admin/queues）查看；聚合结果本身不重要，可随时重跑
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  })
}

/**
 * 入队一次「重建该用户的时间线」（删派生库 + 清库名 + 全量回填）。
 *
 * jobId 加 `rebuild-` 前缀是为了与增量 job（jobId = userId）区分：两者不能互相顶掉，
 * 重建之后紧跟的增量聚合是正常且需要的。
 */
export async function enqueueTimelineRebuild(userId: string): Promise<void> {
  const existing = await timelineQueue.getJob(`rebuild-${userId}`)
  if (existing) {
    const state = await existing.getState()
    if (state === "completed" || state === "failed") await existing.remove()
    else return
  }
  await timelineQueue.add("rebuild", { userId }, {
    jobId: `rebuild-${userId}`,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  })
}

/**
 * 「有新内容了」的通知节流窗口。
 *
 * 一轮抓取里可能几十上百个源都有新条目，每个源都通知一次是纯浪费（订阅者查询 + 一轮聚合
 * 都要读状态文档、写心跳）。窗口内的源 id 先攒着，窗口一开一次性把它们换算成订阅者。
 */
const STALE_NOTIFY_INTERVAL = parseInt(process.env.TIMELINE_NOTIFY_INTERVAL ?? "30000")
let lastStaleNotifyAt = 0
/** 节流窗口内攒下来的脏源（窗口一开合并成一次订阅者查询） */
const pendingStaleSources = new Set<string>()

/**
 * 有源内容变化了 → 把**订阅了这些源的用户**的时间线聚合入队。
 *
 * 两处收敛（实测驱动的）：
 *   1. **只叫醒订阅者**。以前是给所有用户广播，一个没有任何订阅的账号 4 小时被叫醒 332 次，
 *      每次都是一轮"订阅 0 个源，无需搬运"；消费者从 `timeline_source_sync` 反查更准。
 *   2. **窗口内攒源、合并查询**。抓取循环里每来一个新条目就会调一次，30 秒节流窗口内的
 *      源 id 攒起来，窗口一开只查一次订阅者集合。
 */
export async function notifyTimelineStale(sourceId: string, now: number = Date.now()): Promise<void> {
  pendingStaleSources.add(sourceId)
  if (now - lastStaleNotifyAt < STALE_NOTIFY_INTERVAL) return
  lastStaleNotifyAt = now
  const sourceIds = [...pendingStaleSources]
  pendingStaleSources.clear()
  const userIds = await listSubscriberUserIds(sourceIds)
  await Promise.all(userIds.map(id => enqueueTimelineReconcile(id).catch(() => {})))
}

export const timelineWorker = new Worker("rss-timeline", async (job) => {
  const { userId, force } = job.data as { userId: string, force?: boolean }
  const result = job.name === "rebuild"
    ? await rebuildUserTimeline(userId)
    : await reconcileUserTimeline(userId, { force })

  // reconcile 只判定"哪些源脏了"，搬运交给 rss-timeline-sync（限并发）。稳态下 dirtySources 为空，
  // 一个复制请求都不发 —— 这是把常驻复制换成按需复制之后每 5 分钟一轮的全部成本。
  if (result.dirtySources.length > 0) {
    const jobs = await enqueueSourceSyncs(userId, result.dirtySources)
    console.log(
      `[Timeline] user=${userId} 源=${result.sources} 脏源=${result.dirtySources.length} `
      + `（已入队 ${jobs.length} 个单源同步）`,
    )
  }

  // 只在「真的发生了什么」时打日志：每 5 分钟一轮的安静 tick 不该刷屏
  if (result.removedSyncs > 0 || result.removedEntries > 0
    || result.purgedReplications > 0 || result.failures.length > 0) {
    console.log(
      `[Timeline] user=${userId} 源=${result.sources} `
      + `退订清理=${result.removedSyncs} 退订删除=${result.removedEntries} `
      + `清理遗留常驻任务=${result.purgedReplications} `
      + `失败源=${result.failures.length}`,
    )
    for (const failure of result.failures.slice(0, 5)) {
      console.warn(`[Timeline] 源 ${failure.sourceId} 聚合失败：${failure.error}`)
    }
  }
  return result
}, { connection: createWorkerConnection() })

/** 定时把「可能有新内容」的用户排进队列（真正的增量判断在 reconcile 里，安静时只花一条 SQL） */
export async function scheduleTimelineReconciles(): Promise<void> {
  try {
    const userIds = await listUserIds()
    await Promise.all(userIds.map(id => enqueueTimelineReconcile(id).catch(() => {})))
  } catch (err) {
    console.warn("[Timeline] 定时聚合入队失败：", (err as Error)?.message ?? err)
  }
}

const TIMELINE_INTERVAL = parseInt(process.env.TIMELINE_INTERVAL ?? "300000")
const timelineInterval = setInterval(scheduleTimelineReconciles, TIMELINE_INTERVAL)

export async function shutdownTimelineWorkers(): Promise<void> {
  clearInterval(timelineInterval)
  // 强制关闭：一轮聚合（尤其 rebuild）可能跑十几分钟，默认的 close() 会一直等当前 job 结束，
  // 于是 SIGTERM 后的优雅退出卡死、容器只能等超时被 SIGKILL。
  // 丢掉的是「正在处理的那个源」的进度，代价可接受：水位是"开始时刻"、搬完才落 idle，
  // 被中断的源下一轮一定还是脏源；被中断的 job 由 BullMQ 按 stall 检测重新入队。
  // 先关搬运 worker（它在处理真正的复制请求），再关拓扑 worker。
  await shutdownSourceSyncWorker()
  await timelineWorker.close(true)
  await timelineQueue.close()
}
