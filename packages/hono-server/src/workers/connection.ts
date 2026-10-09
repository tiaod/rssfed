import IORedis from "ioredis"

/**
 * BullMQ 共用的 Redis 连接。
 *
 * 抽成独立模块是因为现在有两个队列（RSS 抓取 / 用户时间线聚合）。Worker 的处理器里
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
