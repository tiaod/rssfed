import type { Queue } from "bullmq"

/**
 * 单 feed 抓取入队。
 *
 * BullMQ 按 jobId 去重：同一个 feedId 已有 job 时，`add` 是**静默无效**的（保留旧 job 的
 * payload，不报错也不覆盖）。所以入队前必须先把队列里的旧 job 处理掉，否则：
 *   - 改了订阅 URL 再点「立即抓取」→ 新地址根本没进队列，跑的还是旧地址；
 *   - 上一轮失败留下的 error_message 也一直刷不掉。
 * 2026-10-10 那个「没报错但一直没数据」的 AC 站源就是这么来的。
 *
 * 正在执行（active）的 job 删不掉，只能尽量把 payload 换成最新 URL；换不掉也无妨，
 * 这一轮结束后调度器 / 下一次 refetch 会按最新 URL 重建 job。
 *
 * queue 作为参数传入而不是直接用模块里的单例，是为了能脱离 Redis 单测这段「先清后入队」的语义。
 */
export async function enqueueFetchJob(queue: Queue, feedId: string, url: string): Promise<void> {
  const existing = await queue.getJob(feedId)
  if (existing) {
    const state = await existing.getState()
    if (state === "active") {
      // 正在跑：BullMQ 不允许删除 active job，尽力把 data 换成最新 URL（不同版本可能拒绝，忽略即可）
      await existing.updateData({ feedId, url }).catch(() => {})
    } else {
      await existing.remove()
    }
  }
  await queue.add(`fetch:${feedId}`, { feedId, url }, {
    jobId: feedId,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  })
}
