import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  backgroundSyncEventColor,
  backgroundSyncEventLabel,
  formatBackgroundSyncData,
  formatBackgroundSyncTime,
  summarizeBackgroundSync
} from '~/utils/backgroundSyncLogFormat'
import type { BackgroundSyncEvent } from '~/utils/backgroundSyncLog'

/**
 * 后台同步日志的展示逻辑与汇总。
 *
 * 重点是 `summarizeBackgroundSync` 的 `supported` 推断 —— 它是三态的
 * （true / false / null=还没试过），而面板上「不支持」和「还没试过」给出的建议
 * 完全不同：前者让用户别等了，后者让用户去断一次网。混成一个布尔值会误导排查。
 */

function event(overrides: Partial<BackgroundSyncEvent> = {}): BackgroundSyncEvent {
  return {
    id: 1,
    at: '2026-01-01T10:00:00.000Z',
    kind: 'armed',
    message: 'x',
    ...overrides
  }
}

describe('backgroundSyncEventLabel', () => {
  it('已知 kind 给出中文文案', () => {
    expect(backgroundSyncEventLabel('sync-ok')).toBe('成功')
    expect(backgroundSyncEventLabel('sync-start')).toBe('已触发')
    expect(backgroundSyncEventLabel('armed')).toBe('已登记')
  })

  it('未知 kind 原样显示，不崩', () => {
    expect(backgroundSyncEventLabel('something-new')).toBe('something-new')
  })
})

describe('backgroundSyncEventColor', () => {
  it('成功是 success，失败是 error', () => {
    expect(backgroundSyncEventColor('sync-ok')).toBe('success')
    expect(backgroundSyncEventColor('sync-failed')).toBe('error')
    expect(backgroundSyncEventColor('arm-failed')).toBe('error')
  })

  it('不支持是 warning：它不是错误，是这个浏览器做不到', () => {
    expect(backgroundSyncEventColor('unsupported')).toBe('warning')
  })
})

describe('formatBackgroundSyncTime', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0)

  it('今天只显示时分秒', () => {
    expect(formatBackgroundSyncTime(new Date(2026, 0, 15, 9, 5, 3), now)).toBe('09:05:03')
  })

  it('更早的带上月日', () => {
    expect(formatBackgroundSyncTime(new Date(2026, 0, 14, 9, 5, 3), now)).toBe('01-14 09:05:03')
  })

  it('非法时间给占位符，不显示 Invalid Date', () => {
    expect(formatBackgroundSyncTime('nope', now)).toBe('—')
  })
})

describe('formatBackgroundSyncData', () => {
  it('压成 k=v 并丢掉空值', () => {
    expect(formatBackgroundSyncData({ status: 401, reason: null, note: 'x' })).toBe('status=401 note=x')
  })

  it('null / undefined 给空串', () => {
    expect(formatBackgroundSyncData(null)).toBe('')
    expect(formatBackgroundSyncData(undefined)).toBe('')
  })
})

describe('summarizeBackgroundSync', () => {
  it('空日志：三态是 null（还没试过），不是 false', () => {
    const summary = summarizeBackgroundSync([])
    expect(summary.supported).toBeNull()
    expect(summary.ok).toBe(0)
    expect(summary.lastOkAt).toBeNull()
  })

  it('只有 unsupported：判定为不支持', () => {
    expect(summarizeBackgroundSync([event({ kind: 'unsupported' })]).supported).toBe(false)
  })

  it('有 armed / sync-start 等：判定为支持（即使还失败过）', () => {
    const summary = summarizeBackgroundSync([
      event({ kind: 'armed' }),
      event({ kind: 'sync-failed', id: 2 })
    ])
    expect(summary.supported).toBe(true)
    expect(summary.failed).toBe(1)
  })

  it('成功次数与最近成功时刻取最大的那个', () => {
    const summary = summarizeBackgroundSync([
      event({ kind: 'sync-ok', at: '2026-01-01T10:00:00.000Z', id: 1 }),
      event({ kind: 'sync-ok', at: '2026-01-03T10:00:00.000Z', id: 2 }),
      event({ kind: 'sync-ok', at: '2026-01-02T10:00:00.000Z', id: 3 })
    ])
    expect(summary.ok).toBe(3)
    expect(summary.lastOkAt).toBe('2026-01-03T10:00:00.000Z')
  })

  it('arm-failed 也算失败（登记没成功，后面根本不会有触发）', () => {
    expect(summarizeBackgroundSync([event({ kind: 'arm-failed' })]).failed).toBe(1)
  })
})

/**
 * IndexedDB 层的降级契约。
 *
 * happy-dom 没有 indexedDB，正好就是「隐私模式 / 极老浏览器」的形状：三个函数都必须
 * 安静返回（空数组 / 不抛），因为它们是调试旁路 —— 写日志失败绝不能把同步带崩。
 */
describe('backgroundSyncLog（无 IndexedDB 时的降级）', () => {
  beforeEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(globalThis, 'indexedDB')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('append 不抛', async () => {
    const { appendBackgroundSyncEvent } = await import('~/utils/backgroundSyncLog')
    await expect(appendBackgroundSyncEvent('armed', 'x')).resolves.toBeUndefined()
  })

  it('read 返回空数组', async () => {
    const { readBackgroundSyncEvents } = await import('~/utils/backgroundSyncLog')
    await expect(readBackgroundSyncEvents()).resolves.toEqual([])
  })

  it('clear 不抛', async () => {
    const { clearBackgroundSyncEvents } = await import('~/utils/backgroundSyncLog')
    await expect(clearBackgroundSyncEvents()).resolves.toBeUndefined()
  })
})
