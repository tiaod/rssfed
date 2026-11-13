import IORedis from "ioredis"

/**
 * BullMQ 共用的 Redis 连接。
 *
 * 抽成独立模块是为了**打断循环依赖**：现在有三条队列（抓取 / 时间线对齐 / 单源同步），Worker
 * 处理器调服务层、服务层又可能入队（抓完立刻触发聚合），连接放在各自模块里会绕回来。
 *
 * `maxRetriesPerRequest` 必须为 null：BullMQ 要求阻塞命令不受 ioredis 的重试上限约束，
 * 否则 Redis 抖动时直接抛「max retries per request」而不是重连。
 */
export const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

/**
 * Worker 专用的独立连接。
 *
 * **必须每个 Worker 各一条**：BullMQ 的 Worker 靠阻塞命令（`BRPOPLPUSH` / `BZPOPMIN`）取任务，
 * 阻塞期间这条连接不能再发别的命令。两个 Worker 共用一个实例时，先发起的阻塞调用会把连接占住，
 * 另一个的阻塞命令只能排队 —— 表现为「另一个队列明明有任务却不动，只在对方偶尔有任务时顺带走一个」。
 *
 * Queue 侧（add/getJob 等非阻塞命令）继续共用 `connection` 没问题。
 */
export function createWorkerConnection(): any {
  return connection.duplicate({ maxRetriesPerRequest: null })
}
