import { describe, expect, it } from "vitest"
import { fetchIntervalMs, isFeedDue, type FetchScheduleOptions, type FeedScheduleState } from "../workers/fetch-schedule"

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
