import { describe, expect, it } from 'vitest'
import {
  groupEntriesByReadDay,
  historyDayLabel,
  localDayKey,
  readTimeLabel
} from '../../utils/historyDateGroup'
import type { RssEntry } from '../../types/rss'

/**
 * 历史页日期分组。
 *
 * 所有时间都用「本地时区」构造（`new Date(y, m, d, h, min)`）再转 ISO：断言与运行机器的
 * 时区无关，也不会把「本地日界」误写成 UTC 日界。
 */

function at(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

function makeEntry(id: string, readAt: string | undefined): RssEntry {
  return {
    id,
    feedId: 'f1',
    feed: {
      id: 'f1',
      title: '源',
      siteUrl: 'https://example.com',
      feedUrl: 'https://example.com/rss',
      lastFetchedAt: at(2026, 11, 1)
    },
    title: `条目 ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: at(2026, 11, 1),
    insertedAt: at(2026, 11, 1),
    read: true,
    starred: false,
    readingTime: 1,
    readAt
  }
}

describe('localDayKey', () => {
  it('按本地时区切天（本地当天 00:05 与前一天 23:55 属于不同日期）', () => {
    expect(localDayKey(at(2026, 11, 5, 0, 5))).toBe('2026-11-05')
    expect(localDayKey(at(2026, 11, 4, 23, 55))).toBe('2026-11-04')
  })

  it('缺 readAt / 非法值返回空串', () => {
    expect(localDayKey(undefined)).toBe('')
    expect(localDayKey('not-a-date')).toBe('')
  })
})

describe('historyDayLabel', () => {
  const now = new Date(2026, 10, 5, 20, 0)

  it('今天 / 昨天用相对说法', () => {
    expect(historyDayLabel('2026-11-05', now)).toBe('今天')
    expect(historyDayLabel('2026-11-04', now)).toBe('昨天')
  })

  it('同年更早的日期写月日 + 星期，跨年才带年份', () => {
    // 2026-11-03 是周二
    expect(historyDayLabel('2026-11-03', now)).toBe('11月3日 周二')
    expect(historyDayLabel('2025-12-31', now)).toBe('2025年12月31日 周三')
  })

  it('readAt 缺失的老条目归到「更早」', () => {
    expect(historyDayLabel('', now)).toBe('更早')
  })
})

describe('readTimeLabel', () => {
  it('输出本地时区的 HH:mm（补零）', () => {
    expect(readTimeLabel(at(2026, 11, 5, 9, 5))).toBe('09:05')
    expect(readTimeLabel(at(2026, 11, 5, 19, 30))).toBe('19:30')
  })

  it('缺 readAt / 非法值返回空串（模板据此省略时间）', () => {
    expect(readTimeLabel(undefined)).toBe('')
    expect(readTimeLabel('not-a-date')).toBe('')
  })
})

describe('groupEntriesByReadDay', () => {
  const now = new Date(2026, 10, 5, 20, 0)

  it('按连续同一天分组，并保持传入顺序（不重排「最近读过什么」）', () => {
    const entries = [
      makeEntry('a', at(2026, 11, 5, 19, 3)),
      makeEntry('b', at(2026, 11, 5, 9, 5)),
      makeEntry('c', at(2026, 11, 4, 22, 0)),
      makeEntry('d', at(2026, 11, 3, 8, 0)),
      makeEntry('e', undefined)
    ]

    const groups = groupEntriesByReadDay(entries, now)

    expect(groups.map(g => g.label)).toEqual(['今天', '昨天', '11月3日 周二', '更早'])
    expect(groups.map(g => g.entries.map(e => e.id))).toEqual([['a', 'b'], ['c'], ['d'], ['e']])
  })

  it('空列表没有分组', () => {
    expect(groupEntriesByReadDay([], now)).toEqual([])
  })
})
