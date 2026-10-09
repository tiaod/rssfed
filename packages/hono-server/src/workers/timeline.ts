import { Queue, Worker } from "bullmq"
import { connection } from "./connection"
import { listUserIds, rebuildUserTimeline, reconcileUserTimeline } from "../services/timeline"

/**
 * 用户时间线聚合队列。
 *
 * 与抓取队列分开的理由：抓取的并发与超时特性完全不同（网络抓取、每源一个 job），
 * 聚合是「一个用户一个长事务」，混在一个队列里会让抓取被聚合堵住。
 *
 * jobId 直接用 userId（BullMQ 的 jobId 不允许含冒号），于是同一个用户的聚合请求天然去重：
 * 定时任务、客户端刷新、抓取完成通知三方同时打过来也只会有一个在跑。
 */
export const timelineQueue = new Queue("rss-timeline", { connection })

/** 入队一次用户聚合（同一用户已有排队/执行中的 job 时直接复用） */
export async function enqueueTimelineReconcile(userId: string): Promise<void> {
  const existing = await timelineQueue.getJob(userId)
  if (existing) {
    const state = await existing.getState()
    // 已结束的旧 job 必须先清掉，否则 jobId 会被 BullMQ 判定为重复而拒绝新 job
    if (state === "completed" || state === "failed") await existing.remove()
    else return
  }
  await timelineQueue.add("reconcile", { userId }, {
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
 * 一轮抓取里可能几十上百个源都有新条目，每个源都通知一次「给所有用户入队」是纯浪费
 * （每个用户的聚合都要读一次状态文档 + 一条 SQL）。用户量小的时候这个定时通知
 * 本身就足够便宜，节流的意义只是别让它变成每源一次。
 */
const STALE_NOTIFY_INTERVAL = parseInt(process.env.TIMELINE_NOTIFY_INTERVAL ?? "30000")
let lastStaleNotifyAt = 0

/** 抓取到新条目后调用：把所有用户的时间线聚合入队（带节流） */
export async function notifyTimelineStale(now: number = Date.now()): Promise<void> {
  if (now - lastStaleNotifyAt < STALE_NOTIFY_INTERVAL) return
  lastStaleNotifyAt = now
  const userIds = await listUserIds()
  await Promise.all(userIds.map(id => enqueueTimelineReconcile(id).catch(() => {})))
}

export const timelineWorker = new Worker("rss-timeline", async (job) => {
  const { userId } = job.data as { userId: string }
  const result = job.name === "rebuild"
    ? await rebuildUserTimeline(userId)
    : await reconcileUserTimeline(userId)

  // 只在「真的发生了什么」时打日志：每 5 分钟一轮的安静 tick 不该刷屏
  if (result.addedEntries > 0 || result.removedEntries > 0 || result.prunedEntries > 0 || result.failures.length > 0) {
    console.log(
      `[Timeline] user=${userId} 源=${result.sources} 扫过=${result.scannedSources} ` +
      `新增=${result.addedEntries} 退订删除=${result.removedEntries} 剪枝=${result.prunedEntries} ` +
      `图片失败=${result.imageFailures} 失败源=${result.failures.length}`,
    )
    for (const failure of result.failures.slice(0, 5)) {
      console.warn(`[Timeline] 源 ${failure.sourceId} 聚合失败：${failure.error}`)
    }
  }
  return result
}, { connection })

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
  await timelineWorker.close()
  await timelineQueue.close()
}
