import { describe, it, expect } from 'vitest'
import {
  COMPACT_MIN_INTERVAL_MS,
  IDLE_MAX_POSTPONE_MS,
  IDLE_QUIET_MS,
  IDLE_RECHECK_MS,
  INDEX_CATCHUP_MIN_INTERVAL_MS,
  decideIdleRun,
  shouldCatchUpIndexNow,
  shouldCompactNow
} from '~/utils/localCompact'

/**
 * 「空闲压缩」的门槛判定。
 *
 * 压缩是重活（扫全库），只有「库在、同步空闲、用户没暂停、存储没坏、距上次压缩超过一天」
 * 五个条件同时满足才该压；任一条件不满足都只是这轮不压，不影响任何功能。
 */

const base = {
  now: 10_000_000_000,
  lastCompactedAt: 0,
  syncing: false,
  paused: false,
  storageBroken: false,
  hasDb: true
}

describe('shouldCompactNow', () => {
  it('从未压缩过且一切空闲：压', () => {
    expect(shouldCompactNow(base)).toBe(true)
  })

  it('距上次压缩还不到一天：不压', () => {
    expect(shouldCompactNow({
      ...base,
      lastCompactedAt: base.now - COMPACT_MIN_INTERVAL_MS + 1
    })).toBe(false)
  })

  it('刚好满一天：压（边界含等号）', () => {
    expect(shouldCompactNow({
      ...base,
      lastCompactedAt: base.now - COMPACT_MIN_INTERVAL_MS
    })).toBe(true)
  })

  it.each([
    ['同步进行中', { syncing: true }],
    ['用户暂停了同步', { paused: true }],
    ['存储已熔断', { storageBroken: true }],
    ['本地库还没建', { hasDb: false }]
  ])('%s：不压', (_label, patch) => {
    expect(shouldCompactNow({ ...base, ...patch })).toBe(false)
  })
})

/**
 * 追平视图索引的门槛判定。
 *
 * 与压缩同一组闸门，只有节流间隔不同（十分钟 vs 一天）：追平便宜且没有破坏性，
 * 收益是「点查看不再卡那几秒」，所以要比压缩勤得多。
 */
const catchupBase = {
  now: 10_000_000_000,
  lastIndexCaughtUpAt: 0,
  syncing: false,
  paused: false,
  storageBroken: false,
  hasDb: true
}

describe('shouldCatchUpIndexNow', () => {
  it('从未追平过且一切空闲：追', () => {
    expect(shouldCatchUpIndexNow(catchupBase)).toBe(true)
  })

  it('距上次追平还不到十分钟：不追', () => {
    expect(shouldCatchUpIndexNow({
      ...catchupBase,
      lastIndexCaughtUpAt: catchupBase.now - INDEX_CATCHUP_MIN_INTERVAL_MS + 1
    })).toBe(false)
  })

  it('刚好满十分钟：追（边界含等号）', () => {
    expect(shouldCatchUpIndexNow({
      ...catchupBase,
      lastIndexCaughtUpAt: catchupBase.now - INDEX_CATCHUP_MIN_INTERVAL_MS
    })).toBe(true)
  })

  it.each([
    ['同步进行中', { syncing: true }],
    ['用户暂停了同步', { paused: true }],
    ['存储已熔断', { storageBroken: true }],
    ['本地库还没建', { hasDb: false }]
  ])('%s：不追', (_label, patch) => {
    expect(shouldCatchUpIndexNow({ ...catchupBase, ...patch })).toBe(false)
  })

  it('比压缩勤：间隔必须短于压缩', () => {
    expect(INDEX_CATCHUP_MIN_INTERVAL_MS).toBeLessThan(COMPACT_MIN_INTERVAL_MS)
  })
})

/**
 * 「用户还在动就让位」的判定。
 *
 * 让位本身不难，难在两件事：没记到过操作不能被算成「刚刚才操作过」（否则刚打开应用、
 * 用户还没动手指时永远不会维护），以及让位必须有上限（否则连续用几分钟就等于永远不维护，
 * 索引越拖越厚，下一次点查看还是卡那几秒 —— 正是这套机制要解决的问题本身）。
 */
describe('decideIdleRun', () => {
  const idleBase = {
    now: 10_000_000_000,
    lastActivityAt: 0,
    documentHidden: false,
    dueSince: 0
  }

  it('从没记到过用户操作：直接跑（不能当成刚操作过）', () => {
    expect(decideIdleRun(idleBase)).toEqual({ run: true, reason: 'quiet' })
  })

  it('用户已经停手超过安静窗口：跑', () => {
    expect(decideIdleRun({
      ...idleBase,
      lastActivityAt: idleBase.now - IDLE_QUIET_MS
    })).toEqual({ run: true, reason: 'quiet' })
  })

  it('用户刚操作过：让位，并按「还差多久安静下来」重排', () => {
    const decision = decideIdleRun({
      ...idleBase,
      lastActivityAt: idleBase.now - 1_000
    })
    expect(decision).toEqual({ run: false, retryInMs: IDLE_QUIET_MS - 1_000 })
  })

  it('让位的重排间隔不会短于下限（避免紧贴边界空转）', () => {
    const decision = decideIdleRun({
      ...idleBase,
      // 只差 1ms 就安静下来：仍要等到下限再复查，不能立刻重排
      lastActivityAt: idleBase.now - (IDLE_QUIET_MS - 1)
    })
    expect(decision).toEqual({ run: false, retryInMs: IDLE_RECHECK_MS })
  })

  it('用户一直在动但已经等满上限：照常跑（否则永远等不到空闲）', () => {
    expect(decideIdleRun({
      ...idleBase,
      lastActivityAt: idleBase.now - 100,
      dueSince: idleBase.now - IDLE_MAX_POSTPONE_MS
    })).toEqual({ run: true, reason: 'deadline' })
  })

  it('重排间隔不会越过上限：到点就动手，不往后拖', () => {
    const decision = decideIdleRun({
      ...idleBase,
      lastActivityAt: idleBase.now - 100,
      // 已经等了大半程，安静窗口还差很远：这一步最多只能等到上限
      dueSince: idleBase.now - (IDLE_MAX_POSTPONE_MS - 500)
    })
    expect(decision).toEqual({ run: false, retryInMs: 500 })
  })

  it('页面在后台：没人可打扰，立刻跑（不陪一个看不见的页面耗上限）', () => {
    expect(decideIdleRun({
      ...idleBase,
      lastActivityAt: idleBase.now - 100,
      documentHidden: true
    })).toEqual({ run: true, reason: 'hidden' })
  })
})
