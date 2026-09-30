import { describe, expect, it } from 'vitest'
import {
  needsSync,
  pickFeedsNeedingSync,
  retryBackoffMs,
  inRetryBackoff,
  normalizeMark,
  isStorageFailure,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type SyncedMap,
  type RetryMap
} from '~/utils/syncDecision'
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

  it('v1 旧记录（纯 ISO 字符串）：远端时间戳晚于本地水位 → 同步', () => {
    const synced: SyncedMap = { f1: '2026-01-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-01T00:00:01.000Z', synced)).toBe(true)
  })

  it('v1 旧记录：远端时间戳等于或早于本地水位 → 跳过', () => {
    const synced: SyncedMap = { f1: '2026-01-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-01T00:00:00.000Z', synced)).toBe(false)
    expect(needsSync('f1', '2025-12-31T23:59:59.000Z', synced)).toBe(false)
  })

  it('水位按 feedId 隔离，别的源同步过不影响本源的判断', () => {
    const synced: SyncedMap = { f2: '2026-06-01T00:00:00.000Z' }
    expect(needsSync('f1', '2026-01-02T00:00:00.000Z', synced)).toBe(true)
  })
})

describe('needsSync：v2 水位（直接比服务端 lastNewEntryAt，不受浏览器时钟影响）', () => {
  it('seen 与服务端当前值相同 → 跳过', () => {
    const synced: SyncedMap = {
      f1: { at: '2026-01-01T00:00:00.000Z', seen: '2026-01-02T00:00:00.000Z' }
    }
    expect(needsSync('f1', '2026-01-02T00:00:00.000Z', synced)).toBe(false)
  })

  it('服务端时间戳在 seen 之后又变了 → 同步', () => {
    const synced: SyncedMap = {
      f1: { at: '2026-01-01T00:00:00.000Z', seen: '2026-01-02T00:00:00.000Z' }
    }
    expect(needsSync('f1', '2026-01-02T00:00:01.000Z', synced)).toBe(true)
  })

  it('服务端时钟领先本地时 v1 会一直判定有新内容，v2 能正确跳过', () => {
    const lna = '2026-06-01T00:00:00.000Z' // 服务端写入时间（服务端时钟快）
    // v1：本地记录的是同步完成时间，比服务端时间早 → 永远满足 lastNewEntryAt > at
    const v1: SyncedMap = { f1: '2026-05-31T23:00:00.000Z' }
    expect(needsSync('f1', lna, v1)).toBe(true)
    // v2：记录「上次看到过这个服务端值」，相等即可跳过
    const v2: SyncedMap = { f1: { at: '2026-05-31T23:00:00.000Z', seen: lna } }
    expect(needsSync('f1', lna, v2)).toBe(false)
  })

  it('normalizeMark 兼容 v1 字符串与 v2 对象', () => {
    expect(normalizeMark('2026-01-01T00:00:00.000Z')).toEqual({ at: '2026-01-01T00:00:00.000Z' })
    expect(normalizeMark({ at: 'a', seen: 'b' })).toEqual({ at: 'a', seen: 'b' })
    expect(normalizeMark(undefined)).toBeNull()
  })
})

describe('needsSync：失败退避（避免每轮对同一批失败源全量重试）', () => {
  const now = Date.parse('2026-01-02T00:00:00.000Z')
  const lna = '2026-01-01T00:00:00.000Z'

  it('首次失败后 30s 内不再重试', () => {
    const retry: RetryMap = { f1: { attempts: 1, lastAttemptAt: '2026-01-01T23:59:50.000Z' } }
    expect(needsSync('f1', lna, {}, retry, now)).toBe(false)
    expect(inRetryBackoff('f1', retry, now)).toBe(true)
  })

  it('超过退避窗口后重新尝试', () => {
    const retry: RetryMap = { f1: { attempts: 1, lastAttemptAt: '2026-01-01T23:59:00.000Z' } }
    expect(needsSync('f1', lna, {}, retry, now)).toBe(true)
  })

  it('连续失败退避时间指数增长并封顶', () => {
    expect(retryBackoffMs(0)).toBe(0)
    expect(retryBackoffMs(1)).toBe(RETRY_BASE_MS)
    expect(retryBackoffMs(2)).toBe(RETRY_BASE_MS * 2)
    expect(retryBackoffMs(3)).toBe(RETRY_BASE_MS * 4)
    expect(retryBackoffMs(20)).toBe(RETRY_MAX_MS)
  })

  it('没有退避记录时不受影响', () => {
    expect(needsSync('f1', lna, {}, {}, now)).toBe(true)
  })

  it('退避记录时间非法时按「可重试」处理，不会把源永久卡住', () => {
    const retry: RetryMap = { f1: { attempts: 3, lastAttemptAt: 'not-a-date' } }
    expect(inRetryBackoff('f1', retry, now)).toBe(false)
    expect(needsSync('f1', lna, {}, retry, now)).toBe(true)
  })
})

describe('isStorageFailure', () => {
  it('PouchDB 的 IndexedDB 故障（配额耗尽）命中', () => {
    expect(isStorageFailure({ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' })).toBe(true)
    expect(isStorageFailure({ name: 'QuotaExceededError' })).toBe(true)
    expect(isStorageFailure(new Error('Database has a global failure QuotaExceededError'))).toBe(true)
  })

  it('普通网络 / 业务错误不命中', () => {
    expect(isStorageFailure(new Error('同步失败（HTTP 500）'))).toBe(false)
    expect(isStorageFailure({ status: 404, name: 'not_found' })).toBe(false)
    expect(isStorageFailure(undefined)).toBe(false)
    expect(isStorageFailure('some string error')).toBe(false)
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

  it('退避中的源被跳过，用户状态库不受退避影响', () => {
    const now = Date.parse('2026-01-02T00:00:00.000Z')
    const retry: RetryMap = { f3: { attempts: 2, lastAttemptAt: '2026-01-01T23:59:30.000Z' } }
    const remoteSubs = [sub('f3', '2026-01-02T00:00:00.000Z')]
    expect(pickFeedsNeedingSync(['f3', USER_STATE], remoteSubs, {}, USER_STATE, retry, now)).toEqual([USER_STATE])
  })
})
