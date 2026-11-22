import { describe, it, expect } from 'vitest'
import {
  chunkIds,
  excludeSaved,
  selectFeedsToTrim,
  TRIM_BATCH_SIZE,
  TRIM_MAX_BATCHES,
  TRIM_MAX_FEEDS
} from '~/utils/localTrim'
import { shouldTrimNow, TRIM_MIN_INTERVAL_MS, COMPACT_MIN_INTERVAL_MS } from '~/utils/localCompact'

/**
 * 本地裁剪的纯逻辑判定。
 *
 * 裁剪本身是破坏性的（删条目），所以「删哪些、不删哪些」必须在没有数据库的情况下也能钉死：
 * 误删在订源的条目 = 用户时间线凭空少内容，而且服务端**不会**再送回来
 *（它是用 `_purge` 裁的，purge 不进 `_changes`）。
 */

describe('selectFeedsToTrim', () => {
  it('只挑没有订阅文档的源', () => {
    expect(selectFeedsToTrim(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b'])
  })

  it('全部在订时返回空', () => {
    expect(selectFeedsToTrim(['a', 'b'], new Set(['a', 'b']))).toEqual([])
  })

  it('bot 源与普通源一视同仁（都靠订阅文档判断）', () => {
    expect(selectFeedsToTrim(['bot:123', 'feed-x'], new Set(['bot:123']))).toEqual(['feed-x'])
  })

  it('空 feedId 视为无主数据，一并清掉', () => {
    expect(selectFeedsToTrim(['', 'a'], new Set(['a']))).toEqual([''])
  })

  it('单轮最多挑 TRIM_MAX_FEEDS 个，其余留给下一轮', () => {
    const local = Array.from({ length: TRIM_MAX_FEEDS + 20 }, (_, i) => `f${i}`)
    expect(selectFeedsToTrim(local, new Set()).length).toBe(TRIM_MAX_FEEDS)
  })
})

describe('excludeSaved', () => {
  it('剔除收藏过的条目', () => {
    expect(excludeSaved(['e1', 'e2', 'e3'], new Set(['e2']))).toEqual(['e1', 'e3'])
  })

  it('没有收藏时原样返回（不复制语义之外的东西）', () => {
    expect(excludeSaved(['e1', 'e2'], new Set())).toEqual(['e1', 'e2'])
  })

  it('全都收藏时返回空 —— 一条都不删', () => {
    expect(excludeSaved(['e1'], new Set(['e1']))).toEqual([])
  })
})

describe('chunkIds', () => {
  it('按批量切分，最后一批可以不满', () => {
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']])
  })

  it('空输入得到空批次列表', () => {
    expect(chunkIds([], 10)).toEqual([])
  })

  it('单轮批次数受 TRIM_MAX_BATCHES 限制（防止一轮把 IO 占满）', () => {
    const ids = Array.from({ length: TRIM_BATCH_SIZE * (TRIM_MAX_BATCHES + 5) }, (_, i) => `e${i}`)
    expect(chunkIds(ids).length).toBe(TRIM_MAX_BATCHES)
  })

  it('批量必须为正数', () => {
    expect(() => chunkIds(['a'], 0)).toThrow()
  })
})

describe('shouldTrimNow', () => {
  const base = {
    now: 1_000_000_000,
    lastTrimmedAt: 0,
    syncing: false,
    paused: false,
    storageBroken: false,
    hasDb: true
  }

  it('从没裁过、库在、同步空闲：可以裁', () => {
    expect(shouldTrimNow(base)).toBe(true)
  })

  it('一小时之内不重复裁', () => {
    expect(shouldTrimNow({ ...base, lastTrimmedAt: base.now - TRIM_MIN_INTERVAL_MS + 1 })).toBe(false)
  })

  it('超过一小时就再裁一次', () => {
    expect(shouldTrimNow({ ...base, lastTrimmedAt: base.now - TRIM_MIN_INTERVAL_MS })).toBe(true)
  })

  it('同步中不裁 —— 订阅文档可能还没落库，算出的「退订源」会误删', () => {
    expect(shouldTrimNow({ ...base, syncing: true })).toBe(false)
  })

  it('用户暂停 / 存储熔断 / 库不存在时都不裁', () => {
    expect(shouldTrimNow({ ...base, paused: true })).toBe(false)
    expect(shouldTrimNow({ ...base, storageBroken: true })).toBe(false)
    expect(shouldTrimNow({ ...base, hasDb: false })).toBe(false)
  })

  it('裁剪的节流比压缩短得多（退订要尽快可见，压缩是重活）', () => {
    expect(TRIM_MIN_INTERVAL_MS).toBeLessThan(COMPACT_MIN_INTERVAL_MS)
  })
})
