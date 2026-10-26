import { describe, it, expect } from 'vitest'
import { COMPACT_MIN_INTERVAL_MS, shouldCompactNow } from '~/utils/localCompact'

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
