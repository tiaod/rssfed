import IORedis from "ioredis"

/**
 * BullMQ 共用的 Redis 连接。
 *
 * 抽成独立模块是因为现在有三个队列（RSS 抓取 / 用户时间线拓扑对齐 / 单源按需同步）。Worker 的处理器里
 * 会调用服务层，而服务层又可能需要入队（如抓取完立刻触发一次聚合），
 * 连接放在各自模块里很容易绕成循环依赖。
 *
 * maxRetriesPerRequest 必须为 null：BullMQ 要求阻塞命令不受 ioredis 的重试上限约束，
 * 否则 Redis 抖动时会直接抛「max retries per request」而不是重连。
 */
export const connection = new IORedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
  maxRetriesPerRequest: null,
}) as any

/**
 * Worker 专用的独立连接。
 *
 * BullMQ 的 Worker 靠**阻塞命令**（`BRPOPLPUSH` / `BZPOPMIN`）取任务，阻塞期间这条连接不能再发别的
 * 命令。两个 Worker 共用一个 ioredis 实例时，先发起的那个阻塞调用会把连接占住，另一个的阻塞命令
 * 只能排队等它返回 —— 表现为「另一个队列明明有任务却迟迟不动，只在对方偶尔有任务时才顺带走一个」。
 * 所以每个 Worker 各拿一条 `duplicate()` 出来的连接；Queue 侧（add/getJob 等非阻塞命令）继续共用
 * `connection` 没问题。
 */
export function createWorkerConnection(): any {
  return connection.duplicate({ maxRetriesPerRequest: null })
}
