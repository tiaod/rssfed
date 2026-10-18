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
 * 失败源（errorMessage 非空）保持基础间隔重试，避免一次网络抖动让源几小时不再尝试。
 */

export interface FeedScheduleState {
  /** 上次抓取时间（失败也算，见 markFeedError）；null = 从未抓过 */
  lastFetchedAt: Date | null
  /** 上次抓到**新条目**的时间；null = 订阅以来还没抓到过新内容 */
  lastNewEntryAt: Date | null
  /** 订阅创建时间：新订阅、还没抓到新内容时用它当「安静起点」 */
  createdAt: Date | null
  /** 上次抓取失败的错误信息：非空时保持基础间隔重试 */
  errorMessage?: string | null
}

export interface FetchScheduleOptions {
  /** 基础间隔 = 调度定时器的 tick 间隔（FETCH_INTERVAL） */
  baseIntervalMs: number
  /** 降频上限（FETCH_MAX_INTERVAL） */
  maxIntervalMs: number
  /** false 时退化成旧的「每轮全量入队」行为（FETCH_ADAPTIVE=0） */
  enabled: boolean
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 安静时长 → 间隔倍数；未达到第一档即为基础间隔 */
const TIERS: ReadonlyArray<{ quietMs: number, multiplier: number }> = [
  { quietMs: 2 * HOUR, multiplier: 2 },
  { quietMs: 12 * HOUR, multiplier: 4 },
  { quietMs: 3 * DAY, multiplier: 12 },
  { quietMs: 14 * DAY, multiplier: 24 },
]

/** 该源当前应使用的轮询间隔（ms） */
export function fetchIntervalMs(state: FeedScheduleState, opts: FetchScheduleOptions, nowMs = Date.now()): number {
  if (!opts.enabled) return opts.baseIntervalMs
  if (state.errorMessage) return opts.baseIntervalMs
  const quietSince = Math.max(state.lastNewEntryAt?.getTime() ?? 0, state.createdAt?.getTime() ?? 0)
  // 两个时间都没有（理论上不会发生）：按新源处理，用基础间隔
  if (quietSince === 0) return opts.baseIntervalMs
  const quiet = nowMs - quietSince
  let interval = opts.baseIntervalMs
  for (const tier of TIERS) {
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
