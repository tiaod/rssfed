import { describe, it, expect } from 'vitest'
import { summarizeSyncStatuses, formatSyncedAt, syncStatusLabel, syncStatusDetails } from '../../utils/syncStatusSummary'
import type { SyncStatusLike } from '../../utils/syncStatusSummary'

describe('summarizeSyncStatuses', () => {
  it('没有任何同步记录时是 idle', () => {
    const s = summarizeSyncStatuses({})
    expect(s.state).toBe('idle')
    expect(s.total).toBe(0)
    expect(s.progress).toBe(0)
    expect(s.errorCount).toBe(0)
    expect(s.lastSyncedAt).toBeNull()
  })

  it('有库排队 / 进行中时整体为 syncing，并按已完成库数算进度', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'idle', lastSyncedAt: '2026-09-27T10:00:00.000Z' },
      b: { status: 'syncing' },
      c: { status: 'queued' },
      d: { status: 'queued' }
    }
    const s = summarizeSyncStatuses(statuses)
    expect(s.state).toBe('syncing')
    expect(s.total).toBe(4)
    expect(s.syncing).toBe(1)
    expect(s.queued).toBe(2)
    expect(s.remaining).toBe(3)
    expect(s.done).toBe(1)
    expect(s.progress).toBe(25)
    expect(s.lastSyncedAt).toBe('2026-09-27T10:00:00.000Z')
  })

  it('全部结束且都成功时为 success，lastSyncedAt 取最近一次', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'idle', lastSyncedAt: '2026-09-27T10:00:00.000Z' },
      b: { status: 'idle', lastSyncedAt: '2026-09-27T12:30:00.000Z' }
    }
    const s = summarizeSyncStatuses(statuses)
    expect(s.state).toBe('success')
    expect(s.lastSyncedAt).toBe('2026-09-27T12:30:00.000Z')
    expect(s.errorCount).toBe(0)
    expect(s.progress).toBe(100)
  })

  it('全部结束后只要有一个失败就是 error，并收集失败原因', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'idle', lastSyncedAt: '2026-09-27T12:30:00.000Z' },
      b: { status: 'error', error: '未取到订阅对应的库名' },
      // 边界：status 为 error 但没带原因，也算失败
      c: { status: 'error' }
    }
    const s = summarizeSyncStatuses(statuses)
    expect(s.state).toBe('error')
    expect(s.errorCount).toBe(2)
    expect(s.errors).toEqual(['未取到订阅对应的库名'])
    // 失败不会被已有的成功记录盖掉
    expect(s.lastSyncedAt).toBe('2026-09-27T12:30:00.000Z')
  })

  it('仍有库在同步时，即使已经出现失败也先显示 syncing', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'error', error: '请求超时' },
      b: { status: 'syncing' }
    }
    expect(summarizeSyncStatuses(statuses).state).toBe('syncing')
  })
})

describe('formatSyncedAt', () => {
  const now = new Date('2026-09-27T12:00:00.000Z').getTime()

  it('1 分钟内显示「刚刚」', () => {
    expect(formatSyncedAt('2026-09-27T11:59:30.000Z', now)).toBe('刚刚')
  })

  it('1 小时内显示「x 分钟前」', () => {
    expect(formatSyncedAt('2026-09-27T11:30:00.000Z', now)).toBe('30 分钟前')
  })

  it('超过 1 小时显示时分', () => {
    expect(formatSyncedAt('2026-09-27T09:05:00.000Z', now)).toMatch(/\d{1,2}:\d{2}/)
  })
})

describe('syncStatusLabel / syncStatusDetails（悬停弹层文案）', () => {
  const now = new Date('2026-09-27T12:00:00.000Z').getTime()

  it('同步中：标题 + 本轮进度', () => {
    const s = summarizeSyncStatuses({
      a: { status: 'idle' },
      b: { status: 'syncing' },
      c: { status: 'queued' }
    })
    expect(syncStatusLabel(s.state)).toBe('正在同步')
    expect(syncStatusDetails(s, now)).toEqual(['剩余 2 / 3 个订阅源（33%）'])
  })

  it('失败：原因 + 其余失败数量 + 上次成功时间', () => {
    const s = summarizeSyncStatuses({
      a: { status: 'error', error: '未取到订阅对应的库名' },
      b: { status: 'error', error: '请求超时' },
      c: { status: 'idle', lastSyncedAt: '2026-09-27T11:30:00.000Z' }
    })
    expect(syncStatusLabel(s.state)).toBe('同步失败')
    expect(syncStatusDetails(s, now)).toEqual([
      '未取到订阅对应的库名',
      '另有 1 个订阅源同步失败',
      '上次成功同步：30 分钟前'
    ])
  })

  it('失败但库没带原因：给兜底文案', () => {
    const s = summarizeSyncStatuses({ a: { status: 'error' } })
    expect(syncStatusDetails(s, now)).toEqual(['同步失败，请稍后重试'])
  })

  it('成功：上次同步时间 + 覆盖的订阅源数量', () => {
    const s = summarizeSyncStatuses({
      a: { status: 'idle', lastSyncedAt: '2026-09-27T11:30:00.000Z' },
      b: { status: 'idle', lastSyncedAt: '2026-09-27T11:00:00.000Z' }
    })
    expect(syncStatusLabel(s.state)).toBe('同步成功')
    expect(syncStatusDetails(s, now)).toEqual(['上次同步：30 分钟前', '共 2 个订阅源'])
  })

  it('无记录：提示本次会话还没同步过', () => {
    const s = summarizeSyncStatuses({})
    expect(syncStatusLabel(s.state)).toBe('尚未同步')
    expect(syncStatusDetails(s, now)).toEqual(['本次会话还没有同步记录'])
  })
})
