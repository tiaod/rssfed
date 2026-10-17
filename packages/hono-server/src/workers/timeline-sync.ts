import { Queue, Worker, type Job } from "bullmq"
import { connection, createWorkerConnection } from "./connection"
import { syncSubscriptionSource } from "../services/timeline"

/**
 * 「按需单源同步」队列：一个 job = 一次 (某个源库 → 某个用户的聚合库) 的一次性 CouchDB 复制。
 *
 * 为什么单开一个队列而不是塞进 `rss-timeline`：
 *   - 语义不同：`rss-timeline` 的 job 是"对齐一个用户的整份拓扑"（一个用户一个 job），
 *     这里的 job 是"搬一个源"（一个用户几百个）。混在一起会让拓扑对齐被几百个小任务堵住；
 *   - 并发要分别限：拓扑对齐并发 1 是对的（同一用户重复跑没意义），而搬运**必须有并发**，
 *     否则一个账号的 600 个源要串行搬十几分钟。这个并发就是本次改造要限的东西。
 *
 * 并发默认 4。依据是线上实测：625 条常驻复制一起冲会把 2 核机压到 load 20.8、swap 1.6G/2G；
 * 而 ~50 条并发追赶时 load 1.3、CouchDB CPU 15%、吞吐约 300 条/分钟。单源一次性复制的常态
 * 成本是 1.3s（无内容空转）~3.5s（168 条 × 20KB 全量），4 个并发足够把几百个源在几分钟内
 * 铺开，同时对 CouchDB 很轻。可用 TIMELINE_SYNC_CONCURRENCY 调整。
 *
 * 幂等靠 jobId：同一个 (用户 × 源) 同时只会有一个 job（排队中/执行中都在，重复入队直接复用），
 * 于是「定时 reconcile + 抓取通知 + 客户端手动刷新」三方同时打过来也不会搬两遍。
 */
export const sourceSyncQueue = new Queue("rss-timeline-sync", { connection })

const SYNC_CONCURRENCY = Math.max(1, parseInt(process.env.TIMELINE_SYNC_CONCURRENCY ?? "4") || 4)

export interface SourceSyncJobData {
  userId: string
  sourceId: string
}

/** jobId 不能用冒号（BullMQ 限制），而 sourceId 可能是 `bot:xxx` —— URL 编码消掉 */
export function sourceSyncJobId(userId: string, sourceId: string): string {
  return `${userId}@${encodeURIComponent(sourceId)}`
}

const JOB_OPTS = {
  // 复制失败通常是 CouchDB 忙/源库抖动：指数退避重试几次，别一次就把源判死
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 200 },
}

/**
 * 入队一个源；已有排队/执行中的 job 时复用它（返回该 job，便于 `?wait=1` 等它）。
 *
 * 与 rss-timeline 的入队同一个套路：已结束（completed/failed）的旧 job 必须先删掉，
 * 否则 jobId 会被 BullMQ 判定为重复而拒绝新 job。
 */
export async function enqueueSourceSync(data: SourceSyncJobData): Promise<Job | null> {
  const jobId = sourceSyncJobId(data.userId, data.sourceId)
  const existing = await sourceSyncQueue.getJob(jobId)
  if (existing) {
    const state = await existing.getState()
    if (state !== "completed" && state !== "failed") return existing
    await existing.remove()
  }
  return await sourceSyncQueue.add("sync", data, { ...JOB_OPTS, jobId })
}

/** 批量入队（reconcile 判定出来的脏源），返回可用于等待的 job 列表 */
export async function enqueueSourceSyncs(userId: string, sourceIds: string[]): Promise<Job[]> {
  const jobs: Job[] = []
  for (const sourceId of sourceIds) {
    try {
      const job = await enqueueSourceSync({ userId, sourceId })
      if (job) jobs.push(job)
    } catch (err) {
      // 单个源入队失败不该拦下其余几百个源；下一轮 reconcile 还会把它判成脏源
      console.warn(`[Timeline] 源 ${sourceId} 入队同步失败：${(err as Error)?.message ?? err}`)
    }
  }
  return jobs
}

/** 等这批 job 跑完（手动同步 `?wait=1` 用）；到 deadline 就放弃，返回是否全部结束 */
export async function waitForSourceSyncs(jobs: Job[], deadline: number): Promise<boolean> {
  // 先查一次再判期限：deadline 很近（配置得很小）时也不该把"其实已经跑完"误判成没跑完
  for (;;) {
    const states = await Promise.all(jobs.map(job => job.getState().catch(() => "unknown")))
    if (states.every(state => state === "completed" || state === "failed" || state === "unknown")) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

export const sourceSyncWorker = new Worker("rss-timeline-sync", async (job) => {
  const { userId, sourceId } = job.data as SourceSyncJobData
  const outcome = await syncSubscriptionSource({ userId, sourceId })
  // 安静优先：一轮全量重搬会有几百个源，每个都打一行会把日志刷爆。只在"贵"或"异常"时出声，
  // 平时的进度看队列看板（/admin/queues）与水位表即可。
  if (outcome.skipped) return outcome
  if (outcome.rebound || outcome.elapsedMs > 3_000) {
    console.log(
      `[Timeline] 同步源 ${sourceId}（用户=${userId}）写入 ${outcome.docsWritten} 份、`
      + `${outcome.elapsedMs}ms${outcome.rebound ? "（首搬，从 0 扫该源）" : ""}`,
    )
  }
  return outcome
}, { connection: createWorkerConnection(), concurrency: SYNC_CONCURRENCY })

export async function shutdownSourceSyncWorker(): Promise<void> {
  // force：一次复制可能跑到几十秒，优雅关闭会一直等它，容器只能等超时被 SIGKILL。
  // 丢掉的是"这一条没搬完"，水位不会推进（syncedAt 仍是开始时刻），下一轮必然补上。
  await sourceSyncWorker.close(true)
  await sourceSyncQueue.close()
}
