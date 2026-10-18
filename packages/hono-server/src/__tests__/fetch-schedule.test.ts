import { describe, expect, it } from "vitest"
import {
  fetchIntervalMs,
  isFeedDue,
  feedJitterMs,
  type FetchScheduleOptions,
  type FeedScheduleState,
} from "../workers/fetch-schedule"

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const BASE = 15 * MIN
const NOW = new Date("2026-10-18T00:00:00Z").getTime()

const opts: FetchScheduleOptions = { baseIntervalMs: BASE, maxIntervalMs: 6 * HOUR, enabled: true }

function state(quietMs: number, extra: Partial<FeedScheduleState> = {}): FeedScheduleState {
  return {
    lastFetchedAt: new Date(NOW - quietMs),
    lastNewEntryAt: new Date(NOW - quietMs),
    createdAt: new Date(NOW - 30 * DAY),
    errorMessage: null,
    ...extra,
  }
}

describe("fetchIntervalMs：按「距上次新条目多久」分级降频", () => {
  it("活跃源（2 小时内有过新内容）保持基础间隔", () => {
    expect(fetchIntervalMs(state(30 * MIN), opts, NOW)).toBe(BASE)
    expect(fetchIntervalMs(state(119 * MIN), opts, NOW)).toBe(BASE)
  })

  it("安静 2h / 12h / 3d / 14d 逐级拉长到 2× / 4× / 12× / 上限", () => {
    expect(fetchIntervalMs(state(2 * HOUR), opts, NOW)).toBe(2 * BASE) // 30m
    expect(fetchIntervalMs(state(12 * HOUR), opts, NOW)).toBe(4 * BASE) // 1h
    expect(fetchIntervalMs(state(3 * DAY), opts, NOW)).toBe(12 * BASE) // 3h
    expect(fetchIntervalMs(state(14 * DAY), opts, NOW)).toBe(24 * BASE) // 6h
    expect(fetchIntervalMs(state(60 * DAY), opts, NOW)).toBe(6 * HOUR) // 被 max 封顶
  })

  it("上限可配置，且不会低于基础间隔", () => {
    const capped: FetchScheduleOptions = { ...opts, maxIntervalMs: 2 * HOUR }
    expect(fetchIntervalMs(state(60 * DAY), capped, NOW)).toBe(2 * HOUR)
    expect(fetchIntervalMs(state(30 * MIN), capped, NOW)).toBe(BASE)
  })

  it("从未抓到过新条目时，用 createdAt 当安静起点（新订阅不降频）", () => {
    const fresh: FeedScheduleState = {
      lastFetchedAt: new Date(NOW - 5 * MIN),
      lastNewEntryAt: null,
      createdAt: new Date(NOW - 10 * MIN),
      errorMessage: null,
    }
    expect(fetchIntervalMs(fresh, opts, NOW)).toBe(BASE)
    // 创建很久、始终没抓到新内容 → 降频到上限
    const stale: FeedScheduleState = { ...fresh, createdAt: new Date(NOW - 40 * DAY) }
    expect(fetchIntervalMs(stale, opts, NOW)).toBe(6 * HOUR)
  })

  it("失败源（errorMessage 非空）保持基础间隔重试", () => {
    expect(fetchIntervalMs(state(30 * DAY, { errorMessage: "HTTP 403" }), opts, NOW)).toBe(BASE)
  })

  it("FETCH_ADAPTIVE=0 时退化为基础间隔", () => {
    const disabled: FetchScheduleOptions = { ...opts, enabled: false }
    expect(fetchIntervalMs(state(60 * DAY), disabled, NOW)).toBe(BASE)
  })

  it("base 变化时所有档位按倍数缩放", () => {
    const custom: FetchScheduleOptions = { baseIntervalMs: 10 * MIN, maxIntervalMs: 6 * HOUR, enabled: true }
    expect(fetchIntervalMs(state(30 * MIN), custom, NOW)).toBe(10 * MIN)
    expect(fetchIntervalMs(state(3 * DAY), custom, NOW)).toBe(2 * HOUR) // 12 × 10m
    expect(fetchIntervalMs(state(60 * DAY), custom, NOW)).toBe(4 * HOUR) // 24 × 10m（< 6h 上限）
  })
})

describe("isFeedDue：到期判定（含一个 tick 的容差）", () => {
  it("从未抓过 → 立刻到期", () => {
    expect(isFeedDue({ lastFetchedAt: null, lastNewEntryAt: null, createdAt: null }, opts, NOW)).toBe(true)
  })

  it("基础间隔档：每个 tick 都到期（不会因为 job 晚跑几分钟变成 30m）", () => {
    // 上一轮在 tick 之后 3 分钟才跑完，下一次 tick 只隔了 12 分钟
    expect(isFeedDue(state(12 * MIN), opts, NOW)).toBe(true)
    expect(isFeedDue(state(1 * MIN), opts, NOW)).toBe(true)
  })

  it("2× 档（30m）：隔 10m 不到期，隔 20m 到期", () => {
    const quiet3h = state(3 * HOUR) // interval = 30m
    expect(isFeedDue({ ...quiet3h, lastFetchedAt: new Date(NOW - 10 * MIN) }, opts, NOW)).toBe(false)
    expect(isFeedDue({ ...quiet3h, lastFetchedAt: new Date(NOW - 20 * MIN) }, opts, NOW)).toBe(true)
  })

  it("4× 档（1h）：隔 40m 不到期，隔 50m 到期", () => {
    const quiet1d = state(20 * HOUR) // interval = 1h
    expect(isFeedDue({ ...quiet1d, lastFetchedAt: new Date(NOW - 40 * MIN) }, opts, NOW)).toBe(false)
    expect(isFeedDue({ ...quiet1d, lastFetchedAt: new Date(NOW - 50 * MIN) }, opts, NOW)).toBe(true)
  })

  it("关闭自适应时每轮都到期（旧行为）", () => {
    const disabled: FetchScheduleOptions = { ...opts, enabled: false }
    expect(isFeedDue({ ...state(60 * DAY), lastFetchedAt: new Date(NOW - 1 * MIN) }, disabled, NOW)).toBe(true)
  })
})

describe("无验证器源：降频档位提前一档", () => {
  it("quiet 1h → 30m；6h → 1h；2d → 3h（有验证器源分别是 15m / 30m / 1h）", () => {
    expect(fetchIntervalMs(state(1 * HOUR, { hasFetchValidators: false }), opts, NOW)).toBe(2 * BASE)
    expect(fetchIntervalMs(state(6 * HOUR, { hasFetchValidators: false }), opts, NOW)).toBe(4 * BASE)
    expect(fetchIntervalMs(state(2 * DAY, { hasFetchValidators: false }), opts, NOW)).toBe(12 * BASE)
  })

  it("安静不足 30m 仍用基础间隔（新内容不会迟到）", () => {
    expect(fetchIntervalMs(state(20 * MIN, { hasFetchValidators: false }), opts, NOW)).toBe(BASE)
  })

  it("有验证器或状态未知（老数据/从未抓过）不提前降频", () => {
    expect(fetchIntervalMs(state(1 * HOUR, { hasFetchValidators: true }), opts, NOW)).toBe(BASE)
    expect(fetchIntervalMs(state(1 * HOUR, { hasFetchValidators: null }), opts, NOW)).toBe(BASE)
    expect(fetchIntervalMs(state(1 * HOUR), opts, NOW)).toBe(BASE)
  })

  it("FETCH_NO_VALIDATOR_SLOWDOWN=0 时关闭提前", () => {
    const noSlow: FetchScheduleOptions = { ...opts, slowNonValidator: false }
    expect(fetchIntervalMs(state(1 * HOUR, { hasFetchValidators: false }), noSlow, NOW)).toBe(BASE)
  })
})

describe("失败源：按连续失败次数指数退避", () => {
  function errorState(streak: number | null): FeedScheduleState {
    return state(30 * DAY, { errorMessage: "HTTP 403", errorStreak: streak })
  }

  it("第 1 次失败仍按基础间隔重试（瞬时抖动快速恢复）", () => {
    expect(fetchIntervalMs(errorState(1), opts, NOW)).toBe(BASE)
    expect(fetchIntervalMs(errorState(null), opts, NOW)).toBe(BASE)
  })

  it("连续失败 2/3/4 次 → 30m / 1h / 2h", () => {
    expect(fetchIntervalMs(errorState(2), opts, NOW)).toBe(2 * BASE)
    expect(fetchIntervalMs(errorState(3), opts, NOW)).toBe(4 * BASE)
    expect(fetchIntervalMs(errorState(4), opts, NOW)).toBe(8 * BASE)
  })

  it("退避倍数有上限，且被 FETCH_MAX_INTERVAL 封顶", () => {
    expect(fetchIntervalMs(errorState(6), opts, NOW)).toBe(6 * HOUR)
    expect(fetchIntervalMs(errorState(50), opts, NOW)).toBe(6 * HOUR)
  })

  it("错误源的 isFeedDue 也按退避间隔判定", () => {
    expect(isFeedDue({ ...errorState(3), lastFetchedAt: new Date(NOW - 40 * MIN) }, opts, NOW)).toBe(false)
    expect(isFeedDue({ ...errorState(3), lastFetchedAt: new Date(NOW - 55 * MIN) }, opts, NOW)).toBe(true)
  })
})

describe("feedJitterMs：确定性错峰", () => {
  it("同一 feed 恒定，落在窗口内", () => {
    const a = feedJitterMs("feed_abc", 90_000)
    expect(feedJitterMs("feed_abc", 90_000)).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(90_000)
  })

  it("不同 feed 通常落在不同点（不是所有 job 同一延迟）", () => {
    const values = new Set(["feed_a", "feed_b", "feed_c", "feed_d", "feed_e"].map(id => feedJitterMs(id, 90_000)))
    expect(values.size).toBeGreaterThan(1)
  })

  it("窗口 <= 0 时不抖动", () => {
    expect(feedJitterMs("feed_abc", 0)).toBe(0)
    expect(feedJitterMs("feed_abc", -1)).toBe(0)
  })
})
