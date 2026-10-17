import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMELINE_SETTINGS,
  normalizeTimelineSettings,
  timelineSettingsEqual
} from '~/utils/timelineSettings'

/**
 * 时间线聚合设置的客户端工具层：默认值、归一化、以及「要不要发 PATCH」的判据。
 *
 * 这些设置由**服务端**执行，客户端只负责展示与提交，所以这里只锁一条：
 * 脏值/缺项不能污染 UI（回退默认），也不能凭空发明合法值。
 *
 * 图片参数不在这一层：它们是 per-feed 的、由管理员在订阅源管理里调。
 */

describe('normalizeTimelineSettings', () => {
  it('缺项/空对象回退默认值', () => {
    expect(normalizeTimelineSettings({})).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(null)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(undefined)).toEqual(DEFAULT_TIMELINE_SETTINGS)
  })

  it('AI 开关只认真正的 true（避免 "false" 字符串变成开启）', () => {
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 'false' }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 1 }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: true }).aiSummaryEnabled).toBe(true)
  })

  it('默认关闭 AI 摘要', () => {
    expect(DEFAULT_TIMELINE_SETTINGS.aiSummaryEnabled).toBe(false)
  })

  it('设置对象里只有 AI 开关（图片参数已按源收归管理员）', () => {
    expect(Object.keys(DEFAULT_TIMELINE_SETTINGS)).toEqual(['aiSummaryEnabled'])
  })
})

describe('timelineSettingsEqual', () => {
  it('完全相同 → 相等（据此跳过 PATCH）', () => {
    expect(timelineSettingsEqual(DEFAULT_TIMELINE_SETTINGS, { ...DEFAULT_TIMELINE_SETTINGS })).toBe(true)
  })

  it('任一项不同 → 不等', () => {
    const base = { ...DEFAULT_TIMELINE_SETTINGS }
    expect(timelineSettingsEqual(base, { ...base, aiSummaryEnabled: true })).toBe(false)
  })
})
