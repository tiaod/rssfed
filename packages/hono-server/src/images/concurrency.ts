import os from "node:os"
import pLimit from "p-limit"
import { envInt } from "../env"

/**
 * 图片解码 / AVIF 压缩的**进程级**并发闸门。
 *
 * 为什么必须有一个全局上限：一次压缩要把源图完整解码进内存，代价与「同时压几张」成正比。
 * 实测（4 核，4032×3024 PNG → 缩到 1200px → AVIF q45，同一进程连续压 12 张，走真实
 * `compressToAvif` 路径）：
 *
 *   同时 1 张：峰值 RSS 相对基线 +106MB（12 张共 2.7s）
 *   同时 2 张：+234MB（1.3s）
 *   同时 12 张（改前最坏情况）：+451MB（0.7s）
 *
 * 而抓取侧本来没有任何进程级上限：`FETCH_CONCURRENCY`(默认 4) × 每篇 `DOWNLOAD_CONCURRENCY`(3)
 * = 最多 12 张同时压。生产机只有 2G 内存，再叠加 CouchDB / PostgreSQL / Redis / Nuxt SSR，
 * 几百 MB 的瞬时尖峰就是 OOM 与不 OOM 的差别。
 *
 * 这里只限「同时进行」的操作数，**不改单张参数**（宽度 / 质量 / 每篇体积预算都不动）：
 * 代价是图片处理变慢一点，换来的是内存上界从「抓取并发 × 每篇张数」这种会随配置膨胀的量，
 * 变成一个固定的常量。
 *
 * 用 `p-limit` 而不是自己写：限流器的边界（异常仍要放行名额、FIFO、并发数变更）没必要自己维护。
 * 语义是**进程内**的——跨进程不适用，也不该换成 BullMQ 队列：限制对象是 libvips 的 native 内存，
 * Redis 看不见；而且这些操作本来就在 `rss-fetch` 的 job 里跑，再排一层队列只会多一次 Redis
 * 往返和一份源图序列化。
 */

/** 默认按核数给：2 核 = 1，4 核 = 2，8 核以上 4（压缩是 CPU 密集的，也不该把核占满） */
export function defaultImageConcurrency(cores = os.availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/** 生效的图片并发上限（`IMAGE_CONCURRENCY` 可覆盖；启动日志会打印） */
export const IMAGE_CONCURRENCY = envInt("IMAGE_CONCURRENCY", defaultImageConcurrency())

/**
 * 进程内唯一的图片名额。`p-limit` 保证：同时最多 N 个 fn 在跑、按调用顺序排队、
 * fn 抛错时名额照样放行（内部 finally）。
 */
const limit = pLimit(IMAGE_CONCURRENCY)

/** 在图片并发名额内执行（跨请求共享） */
export function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  return limit(fn)
}
