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
    expect(s.storageError).toBeNull()
  })

  it('本地存储故障优先于同步中/暂停/失败', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'error', error: '请求超时' },
      b: { status: 'syncing' }
    }
    const s = summarizeSyncStatuses(statuses, { paused: true, storageError: '本地缓存写入失败' })
    expect(s.state).toBe('storage-error')
    expect(s.storageError).toBe('本地缓存写入失败')
    // 故障不改变原有的统计口径
    expect(s.total).toBe(2)
    expect(s.remaining).toBe(1)
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

  it('进行中的库按源内进度折算：拉到一半时进度条跟着走，不再原地不动', () => {
    // 一个源，已拉到 60%：老口径（done/total）会一直显示 0%，
    // 而这个源的进展恰恰全在它内部
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'syncing', progress: 60 }
    }
    const s = summarizeSyncStatuses(statuses)
    expect(s.progress).toBe(60)
    expect(s.syncingDetails).toEqual([{ feedId: 'a', progress: 60 }])
  })

  it('没有 progress 的进行中库（服务端未返回 pending）按 0 计，不谎报进度', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'idle' },
      b: { status: 'syncing' }
    }
    const s = summarizeSyncStatuses(statuses)
    // 完成的 1 个满格 + 进行中的 0 → 1/2
    expect(s.progress).toBe(50)
    expect(s.syncingDetails).toEqual([{ feedId: 'b' }])
  })

  it('源内进度折算进总数：完成的库满格、排队的库为零', () => {
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'idle' },
      b: { status: 'syncing', progress: 50, docsWritten: 40 },
      c: { status: 'queued' },
      d: { status: 'queued' }
    }
    const s = summarizeSyncStatuses(statuses)
    // (1 + 0.5) / 4 = 37.5 → 38
    expect(s.progress).toBe(38)
    expect(s.syncingDetails).toEqual([{ feedId: 'b', progress: 50, docsWritten: 40 }])
  })

  it('进度明细最多列出 MAX_SYNCING_DETAILS 条，避免弹层被撑爆', () => {
    const statuses: Record<string, SyncStatusLike> = {}
    for (let i = 0; i < 8; i++) statuses[`f${i}`] = { status: 'syncing', progress: i * 10 }
    const s = summarizeSyncStatuses(statuses)
    expect(s.syncing).toBe(8)
    expect(s.syncingDetails).toHaveLength(4)
  })

  it('用户暂停同步时整体为 paused，且优先于同步中/失败', () => {
    // 暂停由 pauseSync 保证：状态已被归位为 idle，但这里刻意留一个 syncing，
    // 验证 paused 的优先级最高（UIIndicator 据此显示「同步已暂停」）
    const statuses: Record<string, SyncStatusLike> = {
      a: { status: 'error', error: '请求超时' },
      b: { status: 'syncing' }
    }
    expect(summarizeSyncStatuses(statuses, { paused: true }).state).toBe('paused')
    // 未暂停时行为不变
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
    // 第二个源还没拿到 pending：只说「正在拉取」，不显示 0%（那是谎报）
    expect(syncStatusDetails(s, now)).toEqual([
      '剩余 2 / 3 个订阅源（33%）',
      '正在拉取…'
    ])
  })

  it('同步中：逐条列出源内进度（百分比 + 已写入条数）', () => {
    const s = summarizeSyncStatuses({
      a: { status: 'idle' },
      b: { status: 'syncing', progress: 60, docsWritten: 40 }
    })
    expect(syncStatusDetails(s, now)).toEqual([
      '剩余 1 / 2 个订阅源（80%）',
      '已同步 60%（40 条）'
    ])
  })

  it('同步中：进度满了但库还没结束，提示「即将完成」而不是 100%', () => {
    const s = summarizeSyncStatuses({
      b: { status: 'syncing', progress: 100, docsWritten: 120 }
    })
    expect(syncStatusDetails(s, now)).toEqual([
      '剩余 1 / 1 个订阅源（100%）',
      '即将完成（已同步 120 条）'
    ])
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

  it('已暂停：标题与恢复提示（不再显示上轮失败原因）', () => {
    const s = summarizeSyncStatuses(
      { a: { status: 'error', error: '请求超时' } },
      { paused: true }
    )
    expect(syncStatusLabel(s.state)).toBe('同步已暂停')
    expect(syncStatusDetails(s, now)).toEqual(['已停止拉取新内容'])
  })

  it('本地存储故障：标题 + 原因 + 可操作提示（优先于暂停）', () => {
    const s = summarizeSyncStatuses(
      { a: { status: 'error', error: '请求超时' } },
      { paused: true, storageError: '本地缓存写入失败（存储空间不足或数据库已损坏）' }
    )
    expect(syncStatusLabel(s.state)).toBe('本地缓存写入失败')
    expect(syncStatusDetails(s, now)).toEqual([
      '本地缓存写入失败（存储空间不足或数据库已损坏）',
      '点击可重置本地缓存并重新同步'
    ])
  })

  it('本地存储故障但没带原因：给兜底文案', () => {
    const s = summarizeSyncStatuses({}, { storageError: '' })
    // 空串不算故障（沿用调用方传入的原始语义）
    expect(s.state).toBe('idle')
    const s2 = summarizeSyncStatuses({}, { storageError: 'x' })
    expect(syncStatusDetails(s2, now)[0]).toBe('x')
  })
})
