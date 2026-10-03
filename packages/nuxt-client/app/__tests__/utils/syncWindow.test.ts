import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DAY_MS,
  DEFAULT_SYNC_WINDOW_DAYS,
  SYNC_WINDOW_CHOICES,
  anchorKey,
  currentSyncWindowDays,
  normalizeSyncWindowDays,
  resolveWindowAnchor,
  windowSelector,
  type WindowAnchorMap
} from '~/utils/syncWindow'

/**
 * 同步窗口的纯逻辑：窗口天数规范化、锚点稳定性、selector 形状。
 *
 * 这里锁定的是**复制 id 的稳定性**：锚点一旦定下来就不能再跟着时钟变。
 * 它参与 PouchDB 复制 id（generateReplicationId 会把 selector 一起 hash），
 * 锚点每天变一次 = 每天所有订阅源的 _changes 从头重扫一遍。
 */

beforeEach(() => {
  localStorage.clear()
})

describe('窗口天数规范化', () => {
  it('固定档位原样通过（0 = 不限时间）', () => {
    for (const choice of SYNC_WINDOW_CHOICES) {
      expect(normalizeSyncWindowDays(choice.value)).toBe(choice.value)
    }
  })

  it('非法值一律回退默认（3 天）', () => {
    for (const raw of [undefined, null, 'abc', NaN, Infinity, -1, 2, 365, {}, []]) {
      expect(normalizeSyncWindowDays(raw)).toBe(DEFAULT_SYNC_WINDOW_DAYS)
    }
  })
})

describe('窗口锚点', () => {
  const now = Date.parse('2026-03-10T12:00:00.000Z')

  it('按 now - days 生成，并只在首次标记 isNew', () => {
    const anchors: WindowAnchorMap = {}
    const first = resolveWindowAnchor('feed-a|3', 3, anchors, now)
    expect(first.isNew).toBe(true)
    expect(Date.parse(first.anchor!)).toBe(now - 3 * DAY_MS)

    const second = resolveWindowAnchor('feed-a|3', 3, anchors, now + 5 * DAY_MS)
    expect(second.isNew).toBe(false)
    // 关键：时间前进了 5 天，锚点仍是第一条 —— 否则复制 id 变了，checkpoint 作废
    expect(second.anchor).toBe(first.anchor)
  })

  it('不同窗口档位是各自的锚点（各自一条 checkpoint 线）', () => {
    const anchors: WindowAnchorMap = {}
    resolveWindowAnchor(anchorKey('feed-a', 3), 3, anchors, now)
    resolveWindowAnchor(anchorKey('feed-a', 7), 7, anchors, now)
    expect(Object.keys(anchors).sort()).toEqual(['feed-a|3', 'feed-a|7'])
    expect(Date.parse(anchors['feed-a|3']!)).toBe(now - 3 * DAY_MS)
    expect(Date.parse(anchors['feed-a|7']!)).toBe(now - 7 * DAY_MS)
  })

  it('不限时间（0）不生成锚点', () => {
    const anchors: WindowAnchorMap = {}
    expect(resolveWindowAnchor('feed-a|0', 0, anchors, now)).toEqual({ anchor: null, isNew: false })
    expect(anchors).toEqual({})
  })
})

describe('复制 selector', () => {
  it('不限时间时返回 undefined（退回不加过滤的全量复制）', () => {
    expect(windowSelector(null)).toBeUndefined()
  })

  it('放行窗口内条目 + 全部 FeedDoc', () => {
    const selector = windowSelector('2026-03-07T12:00:00.000Z')
    expect(selector).toEqual({
      $or: [
        { type: 'feed' },
        { publishedAt: { $gte: '2026-03-07T12:00:00.000Z' } }
      ]
    })
  })

  it('同一锚点序列化结果逐字相同（键顺序也是稳定性的一部分）', () => {
    const a = JSON.stringify(windowSelector('2026-03-07T12:00:00.000Z'))
    const b = JSON.stringify(windowSelector('2026-03-07T12:00:00.000Z'))
    expect(a).toBe(b)
    expect(a).toBe('{"$or":[{"type":"feed"},{"publishedAt":{"$gte":"2026-03-07T12:00:00.000Z"}}]}')
  })
})

describe('读取设置里的窗口天数', () => {
  it('没有设置时用默认值', () => {
    expect(currentSyncWindowDays()).toBe(DEFAULT_SYNC_WINDOW_DAYS)
  })

  it('读到持久化的档位', () => {
    localStorage.setItem('app-settings', JSON.stringify({ syncWindowDays: 7 }))
    expect(currentSyncWindowDays()).toBe(7)
  })

  it('设置损坏 / 档位非法时回退默认', () => {
    localStorage.setItem('app-settings', '{oops')
    expect(currentSyncWindowDays()).toBe(DEFAULT_SYNC_WINDOW_DAYS)
    localStorage.setItem('app-settings', JSON.stringify({ syncWindowDays: 999 }))
    expect(currentSyncWindowDays()).toBe(DEFAULT_SYNC_WINDOW_DAYS)
  })

  it('SSR（没有 localStorage）下返回默认值', () => {
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(undefined as unknown as Storage)
    expect(currentSyncWindowDays()).toBe(DEFAULT_SYNC_WINDOW_DAYS)
    spy.mockRestore()
  })
})
