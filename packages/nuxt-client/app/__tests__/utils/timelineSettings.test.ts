import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMELINE_SETTINGS,
  TIMELINE_SETTING_LIMITS,
  TIMELINE_WINDOW_CHOICES,
  normalizeTimelineSettings,
  timelineSettingsEqual,
  withCurrentChoice
} from '~/utils/timelineSettings'

/**
 * 时间线聚合设置的客户端工具层：默认值、归一化、以及「要不要发 PATCH」的判据。
 *
 * 这些设置由**服务端**执行，客户端只负责展示与提交，所以这里只锁两条：
 *   1. 脏值/缺项不能污染 UI（回退默认），也不能凭空发明合法值；
 *   2. 下拉档位必须落在服务端允许的区间内（档位是唯一的输入方式，档位越界 = 保存必 400）。
 *
 * 图片参数不在这一层：它们是 per-feed 的、由管理员在订阅源管理里调。
 */

describe('normalizeTimelineSettings', () => {
  it('缺项/空对象回退默认值', () => {
    expect(normalizeTimelineSettings({})).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(null)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(undefined)).toEqual(DEFAULT_TIMELINE_SETTINGS)
  })

  it('保留服务端下发的值（含 0：0 是合法值，表示不限时间）', () => {
    const settings = normalizeTimelineSettings({ windowDays: 0, aiSummaryEnabled: true })
    expect(settings.windowDays).toBe(0)
    expect(settings.aiSummaryEnabled).toBe(true)
  })

  it('脏值回退默认：非数字、负数、NaN、字符串一律不采信', () => {
    const settings = normalizeTimelineSettings({
      windowDays: '7',
      aiSummaryEnabled: 'yes'
    })
    expect(settings.windowDays).toBe(DEFAULT_TIMELINE_SETTINGS.windowDays)
    expect(settings.aiSummaryEnabled).toBe(false)
  })

  it('AI 开关只认真正的 true（避免 "false" 字符串变成开启）', () => {
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 'false' }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 1 }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: true }).aiSummaryEnabled).toBe(true)
  })

  it('设置对象里只有窗口与 AI 开关（图片参数已按源收归管理员）', () => {
    expect(Object.keys(DEFAULT_TIMELINE_SETTINGS).sort()).toEqual(['aiSummaryEnabled', 'windowDays'])
  })
})

describe('timelineSettingsEqual', () => {
  it('完全相同 → 相等（据此跳过 PATCH）', () => {
    expect(timelineSettingsEqual(DEFAULT_TIMELINE_SETTINGS, { ...DEFAULT_TIMELINE_SETTINGS })).toBe(true)
  })

  it('任一项不同 → 不等', () => {
    const base = { ...DEFAULT_TIMELINE_SETTINGS }
    expect(timelineSettingsEqual(base, { ...base, windowDays: 7 })).toBe(false)
    expect(timelineSettingsEqual(base, { ...base, aiSummaryEnabled: true })).toBe(false)
  })
})

describe('withCurrentChoice', () => {
  it('当前值已在档位里 → 原样返回（不多出一项）', () => {
    expect(withCurrentChoice(TIMELINE_WINDOW_CHOICES, 3, '当前')).toBe(TIMELINE_WINDOW_CHOICES)
  })

  it('当前值不在档位里 → 补一项（服务端默认值可以调，客户端列不全）', () => {
    const items = withCurrentChoice(TIMELINE_WINDOW_CHOICES, 5, '当前')
    expect(items).toHaveLength(TIMELINE_WINDOW_CHOICES.length + 1)
    expect(items.find(i => i.value === 5)?.label).toBe('当前（5）')
    // 补进来的项按值排序，不会突兀地挂在末尾
    expect(items.map(i => i.value)).toEqual([...items.map(i => i.value)].sort((a, b) => a - b))
  })

  it('不下拉出空白的根因：空档位表也能承载当前值', () => {
    expect(withCurrentChoice([], 7, '当前')).toEqual([{ label: '当前（7）', value: 7 }])
  })
})

describe('下拉档位', () => {
  it('每一档都落在服务端允许的区间内（档位越界 = 保存必失败）', () => {
    const limit = TIMELINE_SETTING_LIMITS.windowDays
    expect(TIMELINE_WINDOW_CHOICES.length).toBeGreaterThan(0)
    for (const item of TIMELINE_WINDOW_CHOICES) {
      expect(item.value, item.label).toBeGreaterThanOrEqual(limit.min)
      expect(item.value, item.label).toBeLessThanOrEqual(limit.max)
    }
  })

  it('默认值本身必须是某个档位（否则下拉显示空白）', () => {
    const value = DEFAULT_TIMELINE_SETTINGS.windowDays
    expect(TIMELINE_WINDOW_CHOICES.some(i => i.value === value), String(value)).toBe(true)
  })
})
