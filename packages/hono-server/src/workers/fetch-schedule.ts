/**
 * 自适应抓取间隔（调度侧纯函数，不依赖 Redis / 数据库，便于单测）。
 *
 * 背景：几百个源每 15 分钟全量跑一轮，其中大多数源一整天也没几条新内容。
 * 对拿不到 `ETag`/`Last-Modified` 的源，每一轮都是整份下载；即使能 304，也仍是一次
 * 请求 + 一次 FeedDoc 写入。按「距上次抓到新条目多久」把轮询间隔分级拉长，抓到新内容
 * 立刻回到基础间隔，可以同时省流量、请求数和 CouchDB 写入：
 *
 *   quiet < 2h    → 1×base（默认 15m）
 *   quiet < 12h   → 2×base（30m）
 *   quiet < 3d    → 4×base（1h）
 *   quiet < 14d   → 12×base（3h）
 *   更久           → max（默认 6h）
 *
 * 用「新条目时间」而不是「连续空轮次数」做输入，是为了不引入持久化计数器：PostgreSQL 的
 * `feeds.lastNewEntryAt` 已经是这份信息的系统记录，调度器直接读它即可（重启不丢、无需迁移）。
 *
 * **没有条件请求验证器的源**（`hasFetchValidators === false`，worker 抓取时记录）：
 * 每轮都是整份下载，降频档位整体提前一档（见 NON_VALIDATOR_TIERS），用「最多晚一点发现」
 * 换掉近一半的全量下载（实测这类源占 345/705，贡献约 7,250 次全量下载/天）。
 *
 * **失败源**按连续失败次数指数退避（15m→30m→1h→2h→4h→6h），避免 19 个已失效的源
 * 每 15 分钟白打一次外网；成功一次即清零（`errorStreak` 由 worker 维护）。
 */

export interface FeedScheduleState {
  /** 上次抓取时间（失败也算，见 markFeedError）；null = 从未抓过 */
  lastFetchedAt: Date | null
  /** 上次抓到**新条目**的时间；null = 订阅以来还没抓到过新内容 */
  lastNewEntryAt: Date | null
  /** 订阅创建时间：新订阅、还没抓到新内容时用它当「安静起点」 */
  createdAt: Date | null
  /** 上次抓取失败的错误信息：非空时走错误退避 */
  errorMessage?: string | null
  /** 连续失败次数（成功抓取后归零，见 worker 的 errorStreak） */
  errorStreak?: number | null
  /**
   * 上一次成功响应是否带回了 ETag/Last-Modified。
   * `false` = 每轮都整份下载（用更激进的降频）；`null`/`undefined`（老数据、从未抓过）= 按有验证器处理。
   */
  hasFetchValidators?: boolean | null
}

export interface FetchScheduleOptions {
  /** 基础间隔 = 调度定时器的 tick 间隔（FETCH_INTERVAL） */
  baseIntervalMs: number
  /** 降频上限（FETCH_MAX_INTERVAL） */
  maxIntervalMs: number
  /** false 时退化成旧的「每轮全量入队」行为（FETCH_ADAPTIVE=0） */
  enabled: boolean
  /** 无验证器源的降频档位提前一档（FETCH_NO_VALIDATOR_SLOWDOWN=0 关闭） */
  slowNonValidator?: boolean
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 安静时长 → 间隔倍数；未达到第一档即为基础间隔 */
const TIERS: ReadonlyArray<{ quietMs: number, multiplier: number }> = [
  { quietMs: 2 * HOUR, multiplier: 2 },
  { quietMs: 12 * HOUR, multiplier: 4 },
  { quietMs: 3 * DAY, multiplier: 12 },
  { quietMs: 14 * DAY, multiplier: 24 },
]

/**
 * 无验证器源的档位：相对 TIERS **整体提前一档**。
 * 对照：1h 安静时 30m 一次（有验证器源是 15m）；6h 时 1h 一次；2d 时 3h 一次。
 */
const NON_VALIDATOR_TIERS: ReadonlyArray<{ quietMs: number, multiplier: number }> = [
  { quietMs: 30 * MINUTE, multiplier: 2 },
  { quietMs: 3 * HOUR, multiplier: 4 },
  { quietMs: 18 * HOUR, multiplier: 12 },
  { quietMs: 3 * DAY + 12 * HOUR, multiplier: 24 },
]

/** 错误源退避的最大倍数（15m × 2^5 = 8h，再被 maxIntervalMs 封顶） */
const MAX_ERROR_BACKOFF_STEPS = 5

/** 该源当前应使用的轮询间隔（ms） */
export function fetchIntervalMs(state: FeedScheduleState, opts: FetchScheduleOptions, nowMs = Date.now()): number {
  if (!opts.enabled) return opts.baseIntervalMs
  // 失败源：先按连续失败次数退避，不要再叠加静态降频（否则两个维度相乘很难解释）
  if (state.errorMessage) {
    const steps = Math.min(Math.max(1, state.errorStreak ?? 1), MAX_ERROR_BACKOFF_STEPS + 1) - 1
    return Math.min(opts.baseIntervalMs * 2 ** steps, opts.maxIntervalMs)
  }
  const quietSince = Math.max(state.lastNewEntryAt?.getTime() ?? 0, state.createdAt?.getTime() ?? 0)
  // 两个时间都没有（理论上不会发生）：按新源处理，用基础间隔
  if (quietSince === 0) return opts.baseIntervalMs
  const quiet = nowMs - quietSince
  const tiers = opts.slowNonValidator !== false && state.hasFetchValidators === false
    ? NON_VALIDATOR_TIERS
    : TIERS
  let interval = opts.baseIntervalMs
  for (const tier of tiers) {
    if (quiet < tier.quietMs) break
    interval = opts.baseIntervalMs * tier.multiplier
  }
  return Math.min(interval, opts.maxIntervalMs)
}

/** 本轮是否应该为该源入队抓取任务 */
export function isFeedDue(state: FeedScheduleState, opts: FetchScheduleOptions, nowMs = Date.now()): boolean {
  if (!state.lastFetchedAt) return true // 从未抓过：立刻抓
  const interval = fetchIntervalMs(state, opts, nowMs)
  // 所有档位都是基础间隔的整数倍，而调度器每 baseIntervalMs 才检查一次。
  // 留一个 tick 的容差：否则「job 在 tick 之后几分钟才跑完」会让 15m 档实际变成 30m
  //（elapsed 12m < 15m → 本轮跳过 → 下一轮才是 27m）。
  return nowMs - state.lastFetchedAt.getTime() + opts.baseIntervalMs >= interval
}

/**
 * 确定性调度抖动（同一 feed 恒定，落在 `0..spanMs-1`）。
 *
 * 一个 tick 里到期的源可能有两三百个（实测 275），同时入队会让 worker 在同一时刻
 * 打出几百个请求（对代理和目标站都不友好）。用 `job.opts.delay` 把它们摊到 `spanMs`
 * 内错峰；哈希取 feedId 而不是随机数，保证同一次抓取延迟稳定、便于复现。
 */
export function feedJitterMs(feedId: string, spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0
  let hash = 0
  for (let i = 0; i < feedId.length; i++) hash = (hash * 31 + feedId.charCodeAt(i)) >>> 0
  return hash % spanMs
}
