import { describe, expect, it } from 'vitest'
import { needsSync, pickFeedsNeedingSync, type SyncedMap } from '~/utils/syncDecision'
import type { FeedSubscriptionItem } from '~/types/rss'

/** 构造远端订阅项（只关心 feedId / lastNewEntryAt，其余字段与判断无关） */
function sub(feedId: string, lastNewEntryAt?: string): FeedSubscriptionItem {
  return {
    feedId,
    title: feedId,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    lastNewEntryAt
  }
}

describe('needsSync', () => {
  it('服务器从未抓到新条目（无 lastNewEntryAt）→ 不同步，没有可拉取的内容', () => {
    expect(needsSync('f1', undefined, {})).toBe(false)
    // 即便本地有水位记录也不该同步：远端确实没有新东西
    expect(needsSync('f1', undefined, { f1: '2026-01-01T00:00:00.000Z' })).toBe(false)
  })

  it('有 lastNewEntryAt 但本地从无水位记录（首次/新订阅）→ 同步', () => {
    expect(needsSync('f1', '2026-01-02T00:00:00.000Z', {})).toBe(true)
  })

  it('远端时间戳晚于本地水位 → 同步', () => {
    const synced: SyncedMap = { f1: '2026-01-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-01T00:00:01.000Z', synced)).toBe(true)
  })

  it('远端时间戳等于或早于本地水位 → 跳过（上次同步后确实没变）', () => {
    const synced: SyncedMap = { f1: '2026-01-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-01T00:00:00.000Z', synced)).toBe(false)
    expect(needsSync('f1', '2025-12-31T23:59:59.000Z', synced)).toBe(false)
  })

  it('水位按 feedId 隔离，别的源同步过不影响本源的判断', () => {
    const synced: SyncedMap = { f2: '2026-06-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-02T00:00:00.000Z', synced)).toBe(true)
  })
})

describe('pickFeedsNeedingSync', () => {
  const USER_STATE = '__user_state__'
  const synced: SyncedMap = {
    f1: '2026-01-01T00:00:00.000Z',
    f2: '2026-01-01T00:00:00.000Z'
  }

  it('只保留「有新内容」「从未同步过」「不在远端列表」与用户状态库', () => {
    const remoteSubs = [
      sub('f1', '2025-12-31T00:00:00.000Z'), // 水位之后没变 → 跳过
      sub('f2', '2026-01-02T00:00:00.000Z'), // 水位之后有新内容 → 保留
      sub('f3', '2026-01-02T00:00:00.000Z'), // 无本地水位 → 保留
      sub('f4') // 服务器从未抓到新条目 → 跳过
    ]
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5', USER_STATE]

    expect(pickFeedsNeedingSync(ids, remoteSubs, synced, USER_STATE)).toEqual([
      'f2', // 有新内容
      'f3', // 从未同步过
      'f5', // 不在远端列表（本地刚订阅，尚未推送）→ fail-open 保留
      USER_STATE // 无 lastNewEntryAt 概念，始终保留
    ])
  })

  it('离线（远端列表为 null）→ 全部保留，降级为不过滤', () => {
    const ids = ['f1', 'f4', USER_STATE]
    expect(pickFeedsNeedingSync(ids, null, synced, USER_STATE)).toEqual(ids)
  })

  it('返回新数组，不改动调用方传入的 ids', () => {
    const ids = ['f1', 'f2']
    const result = pickFeedsNeedingSync(ids, null, synced, USER_STATE)
    expect(result).not.toBe(ids)
    expect(ids).toEqual(['f1', 'f2'])
  })

  it('全部无变化时返回空数组（调用方据此跳过复制请求）', () => {
    const remoteSubs = [
      sub('f1', '2025-12-31T00:00:00.000Z'),
      sub('f2', '2025-12-31T00:00:00.000Z')
    ]
    expect(pickFeedsNeedingSync(['f1', 'f2'], remoteSubs, synced, USER_STATE)).toEqual([])
  })

  it('空目标集合 → 空数组', () => {
    expect(pickFeedsNeedingSync([], [], synced, USER_STATE)).toEqual([])
  })
})
