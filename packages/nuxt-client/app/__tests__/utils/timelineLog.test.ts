import { describe, expect, it } from 'vitest'
import {
  formatSince,
  formatTimelineEventData,
  formatTimelineEventTime,
  summarizeTimelineSources,
  timelineEventColor,
  timelineEventLabel
} from '~/utils/timelineLog'
import type { TimelineSourceState } from '~/types/timeline-log'

/**
 * 同步日志面板的纯展示逻辑。
 *
 * 这类东西出错不会报错、只会"看起来对但读错"（把失败显示成汇聚、把昨天的时间显示成今天），
 * 而它恰恰是排查时第一眼要看的东西，所以把映射与格式化钉住。
 */

describe('timelineEventLabel / timelineEventColor', () => {
  it('已知类型给中文徽标，未知类型原样显示（服务端以后加 kind 不会显示空白）', () => {
    expect(timelineEventLabel('reconcile')).toBe('汇聚')
    expect(timelineEventLabel('rebuild')).toBe('重建')
    expect(timelineEventLabel('source-sync')).toBe('首搬')
    expect(timelineEventLabel('error')).toBe('失败')
    expect(timelineEventLabel('something-new')).toBe('something-new')
  })

  it('level 优先决定颜色：error/warn 不管什么类型都刺眼', () => {
    expect(timelineEventColor('reconcile', 'error')).toBe('error')
    expect(timelineEventColor('source-sync', 'warn')).toBe('warning')
    expect(timelineEventColor('source-sync', 'info')).toBe('info')
    expect(timelineEventColor('reconcile', 'info')).toBe('neutral')
    expect(timelineEventColor('rebuild', 'info')).toBe('neutral')
  })
})

describe('formatTimelineEventTime', () => {
  const now = new Date(2026, 9, 17, 12, 0, 0) // 本地时间 2026-10-17 12:00

  it('当天只显示时分秒（一轮汇聚的具体时刻）', () => {
    expect(formatTimelineEventTime(new Date(2026, 9, 17, 6, 4, 30), now)).toBe('06:04:30')
    expect(formatTimelineEventTime(new Date(2026, 9, 17, 23, 59, 5), now)).toBe('23:59:05')
  })

  it('不在当天时补上日期', () => {
    expect(formatTimelineEventTime(new Date(2026, 9, 16, 22, 0, 0), now)).toBe('10-16 22:00:00')
    expect(formatTimelineEventTime(new Date(2026, 8, 3, 8, 5, 9), now)).toBe('09-03 08:05:09')
  })

  it('非法时间给占位符而不是 NaN:NaN', () => {
    expect(formatTimelineEventTime('not-a-date', now)).toBe('—')
  })
})

describe('formatSince', () => {
  const now = new Date(2026, 9, 17, 12, 0, 0)

  it('没同步过显示「从未」', () => {
    expect(formatSince(null, now)).toBe('从未')
  })

  it('按秒/分/小时给相对时间', () => {
    expect(formatSince(new Date(2026, 9, 17, 11, 59, 30), now)).toBe('30 秒前')
    expect(formatSince(new Date(2026, 9, 17, 11, 55, 0), now)).toBe('5 分钟前')
    expect(formatSince(new Date(2026, 9, 17, 9, 0, 0), now)).toBe('3 小时前')
  })

  it('超过一天就显示具体时间', () => {
    expect(formatSince(new Date(2026, 9, 15, 9, 0, 0), now)).toBe('10-15 09:00:00')
  })
})

describe('formatTimelineEventData', () => {
  it('压成 k=v 一行，跳过空值', () => {
    expect(formatTimelineEventData({ sources: 129, dirty: 0, note: null, empty: '', missing: undefined }))
      .toBe('sources=129 dirty=0')
  })

  it('没有补充数据就是空串（模板里据此不渲染那个点）', () => {
    expect(formatTimelineEventData(null)).toBe('')
    expect(formatTimelineEventData({})).toBe('')
    expect(formatTimelineEventData({ note: null })).toBe('')
  })

  it('嵌套对象序列化成 JSON', () => {
    expect(formatTimelineEventData({ failures: [{ sourceId: 'f1' }] })).toBe('failures=[{"sourceId":"f1"}]')
  })
})

describe('summarizeTimelineSources', () => {
  const source = (over: Partial<TimelineSourceState>): TimelineSourceState => ({
    sourceId: 'f1',
    kind: 'feed',
    title: '源',
    syncedAt: null,
    status: 'idle',
    lastError: null,
    ...over
  })

  it('统计总数、失败、进行中，并取最近的同步时刻', () => {
    const summary = summarizeTimelineSources([
      source({ sourceId: 'a', syncedAt: '2026-10-17T06:00:00.000Z' }),
      source({ sourceId: 'b', syncedAt: '2026-10-17T06:04:31.000Z' }),
      source({ sourceId: 'c', status: 'error', syncedAt: '2026-10-17T05:00:00.000Z' }),
      source({ sourceId: 'd', status: 'syncing' })
    ])
    expect(summary.total).toBe(4)
    expect(summary.errors).toBe(1)
    expect(summary.syncing).toBe(1)
    expect(summary.lastSyncedAt).toBe('2026-10-17T06:04:31.000Z')
  })

  it('一个源都没同步过时 lastSyncedAt 是 null', () => {
    const summary = summarizeTimelineSources([source({ sourceId: 'a' })])
    expect(summary.lastSyncedAt).toBeNull()
  })
})
