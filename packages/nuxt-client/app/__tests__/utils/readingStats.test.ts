import { describe, expect, it } from 'vitest'
import { startOfDay, startOfWeek, summarizeReading } from '../../utils/readingStats'

/**
 * 时间线右栏「阅读小结」的计数口径。
 *
 * 时间一律用「本地时区」构造再转 ISO（见 historyDateGroup.test.ts 的同一做法）：
 * 「今天」「最近 7 天」都是本地自然日，不能写成 UTC 日界，否则断言会随运行时区漂移。
 */

function at(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

const NOW = new Date(2026, 10, 15, 19, 30) // 2026-11-15 19:30 本地时间

describe('startOfDay / startOfWeek', () => {
  it('今天从本地 00:00 起算', () => {
    const day = new Date(startOfDay(NOW))
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 10, 15])
    expect([day.getHours(), day.getMinutes()]).toEqual([0, 0])
  })

  it('最近 7 天是 7 个自然日：今天往前推 6 天，而不是减 7×24 小时', () => {
    const week = new Date(startOfWeek(NOW))
    expect([week.getMonth(), week.getDate(), week.getHours()]).toEqual([10, 9, 0])
  })
})

describe('summarizeReading', () => {
  it('空库返回全 0', () => {
    expect(summarizeReading([], NOW)).toEqual({
      today: 0, week: 0, total: 0, saved: 0, savedUnread: 0
    })
  })

  it('今天读的进 today 与 week', () => {
    const result = summarizeReading([
      { read: true, readAt: at(2026, 11, 15, 9) },
      { read: true, readAt: at(2026, 11, 15, 18) }
    ], NOW)
    expect(result.today).toBe(2)
    expect(result.week).toBe(2)
    expect(result.total).toBe(2)
  })

  it('今天的边界：00:00 整算今天，前一秒算昨天', () => {
    const result = summarizeReading([
      { read: true, readAt: at(2026, 11, 15, 0, 0) },
      { read: true, readAt: new Date(2026, 10, 14, 23, 59).toISOString() }
    ], NOW)
    expect(result.today).toBe(1)
    expect(result.week).toBe(2)
  })

  it('7 天窗口含第 7 天、不含第 8 天', () => {
    const result = summarizeReading([
      { read: true, readAt: at(2026, 11, 9, 0, 0) }, // 第 7 天，最老的一端点
      { read: true, readAt: at(2026, 11, 8, 23, 59) } // 第 8 天
    ], NOW)
    expect(result.week).toBe(1)
    expect(result.total).toBe(2)
  })

  it('老文档没有 readAt：算读过、算总数，但不进今天/本周', () => {
    const result = summarizeReading([{ read: true }], NOW)
    expect(result).toEqual({ today: 0, week: 0, total: 1, saved: 0, savedUnread: 0 })
  })

  it('readAt 脏值当作没有时间戳，不会算进今天', () => {
    const result = summarizeReading([{ read: true, readAt: '不是时间' }], NOW)
    expect(result.total).toBe(1)
    expect(result.today).toBe(0)
  })

  it('收藏未读进待读，收藏已读不算', () => {
    const result = summarizeReading([
      { saved: true },
      { saved: true, read: true, readAt: at(2026, 11, 15, 8) },
      { read: true, readAt: at(2026, 11, 15, 9) }
    ], NOW)
    expect(result.saved).toBe(2)
    expect(result.savedUnread).toBe(1)
    expect(result.total).toBe(2)
  })

  it('read: false 的文档不计入读过（标未读会把 read 置回 false）', () => {
    const result = summarizeReading([
      { read: false, readAt: at(2026, 11, 15, 9) }
    ], NOW)
    expect(result.total).toBe(0)
    expect(result.today).toBe(0)
  })
})
