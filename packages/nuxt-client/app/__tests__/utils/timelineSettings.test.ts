import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMELINE_SETTINGS,
  TIMELINE_ENTRY_BYTES_CHOICES,
  TIMELINE_IMAGE_COUNT_CHOICES,
  TIMELINE_IMAGE_WIDTH_CHOICES,
  TIMELINE_QUALITY_CHOICES,
  TIMELINE_SETTING_LIMITS,
  TIMELINE_SOURCE_BYTES_CHOICES,
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
 */

describe('normalizeTimelineSettings', () => {
  it('缺项/空对象回退默认值', () => {
    expect(normalizeTimelineSettings({})).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(null)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(undefined)).toEqual(DEFAULT_TIMELINE_SETTINGS)
  })

  it('保留服务端下发的值（含 0：0 是合法值，表示不限时间/不缓存）', () => {
    const settings = normalizeTimelineSettings({
      windowDays: 0,
      maxImageCount: 0,
      maxEntryImageBytes: 0,
      maxImageWidth: 800,
      avifQuality: 60,
      maxSourceImageBytes: 2 * 1024 * 1024,
      aiSummaryEnabled: true
    })
    expect(settings.windowDays).toBe(0)
    expect(settings.maxImageCount).toBe(0)
    expect(settings.maxEntryImageBytes).toBe(0)
    expect(settings.aiSummaryEnabled).toBe(true)
  })

  it('脏值回退默认：非数字、负数、NaN、字符串一律不采信', () => {
    const settings = normalizeTimelineSettings({
      windowDays: '7',
      maxImageCount: -1,
      maxEntryImageBytes: Number.NaN,
      maxImageWidth: null,
      avifQuality: Infinity
    })
    expect(settings.windowDays).toBe(DEFAULT_TIMELINE_SETTINGS.windowDays)
    expect(settings.maxImageCount).toBe(DEFAULT_TIMELINE_SETTINGS.maxImageCount)
    expect(settings.maxEntryImageBytes).toBe(DEFAULT_TIMELINE_SETTINGS.maxEntryImageBytes)
    expect(settings.maxImageWidth).toBe(DEFAULT_TIMELINE_SETTINGS.maxImageWidth)
    expect(settings.avifQuality).toBe(DEFAULT_TIMELINE_SETTINGS.avifQuality)
  })

  it('AI 开关只认真正的 true（避免 "false" 字符串变成开启）', () => {
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 'false' }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 1 }).aiSummaryEnabled).toBe(false)
    expect(normalizeTimelineSettings({ aiSummaryEnabled: true }).aiSummaryEnabled).toBe(true)
  })
})

describe('timelineSettingsEqual', () => {
  it('完全相同 → 相等（据此跳过 PATCH）', () => {
    expect(timelineSettingsEqual(DEFAULT_TIMELINE_SETTINGS, { ...DEFAULT_TIMELINE_SETTINGS })).toBe(true)
  })

  it('任一字段不同 → 不等', () => {
    const base = { ...DEFAULT_TIMELINE_SETTINGS }
    expect(timelineSettingsEqual(base, { ...base, windowDays: 7 })).toBe(false)
    expect(timelineSettingsEqual(base, { ...base, maxImageCount: 3 })).toBe(false)
    expect(timelineSettingsEqual(base, { ...base, aiSummaryEnabled: true })).toBe(false)
    expect(timelineSettingsEqual(base, { ...base, avifQuality: 75 })).toBe(false)
  })
})

describe('withCurrentChoice', () => {
  it('当前值已在档位里 → 原样返回（不多出一项）', () => {
    expect(withCurrentChoice(TIMELINE_QUALITY_CHOICES, 45, '当前')).toBe(TIMELINE_QUALITY_CHOICES)
  })

  it('当前值不在档位里 → 补一项（服务端默认值可用环境变量调，客户端列不全）', () => {
    const items = withCurrentChoice(TIMELINE_QUALITY_CHOICES, 55, '当前：质量')
    expect(items).toHaveLength(TIMELINE_QUALITY_CHOICES.length + 1)
    expect(items.find(i => i.value === 55)?.label).toBe('当前：质量（55）')
    // 补进来的项按值排序，不会突兀地挂在末尾
    expect(items.map(i => i.value)).toEqual([...items.map(i => i.value)].sort((a, b) => a - b))
  })

  it('不下拉出空白的根因：空档位表也能承载当前值', () => {
    expect(withCurrentChoice([], 7, '当前')).toEqual([{ label: '当前（7）', value: 7 }])
  })
})

describe('下拉档位', () => {
  const choices: Array<[string, Array<{ label: string, value: number }>, { min: number, max: number }]> = [
    ['窗口', [...TIMELINE_WINDOW_CHOICES], TIMELINE_SETTING_LIMITS.windowDays],
    ['图片张数', [...TIMELINE_IMAGE_COUNT_CHOICES], TIMELINE_SETTING_LIMITS.maxImageCount],
    ['附件体积', [...TIMELINE_ENTRY_BYTES_CHOICES], TIMELINE_SETTING_LIMITS.maxEntryImageBytes],
    ['图片宽度', [...TIMELINE_IMAGE_WIDTH_CHOICES], TIMELINE_SETTING_LIMITS.maxImageWidth],
    ['图片质量', [...TIMELINE_QUALITY_CHOICES], TIMELINE_SETTING_LIMITS.avifQuality],
    ['源图上限', [...TIMELINE_SOURCE_BYTES_CHOICES], TIMELINE_SETTING_LIMITS.maxSourceImageBytes]
  ]

  it('每一档都落在服务端允许的区间内（档位越界 = 保存必失败）', () => {
    for (const [name, items, limit] of choices) {
      expect(items.length, name).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.value, `${name} ${item.label}`).toBeGreaterThanOrEqual(limit.min)
        expect(item.value, `${name} ${item.label}`).toBeLessThanOrEqual(limit.max)
      }
    }
  })

  it('默认值本身必须是某个档位（否则下拉显示空白）', () => {
    const pairs: Array<[number, Array<{ label: string, value: number }>]> = [
      [DEFAULT_TIMELINE_SETTINGS.windowDays, TIMELINE_WINDOW_CHOICES],
      [DEFAULT_TIMELINE_SETTINGS.maxImageCount, TIMELINE_IMAGE_COUNT_CHOICES],
      [DEFAULT_TIMELINE_SETTINGS.maxEntryImageBytes, TIMELINE_ENTRY_BYTES_CHOICES],
      [DEFAULT_TIMELINE_SETTINGS.maxImageWidth, TIMELINE_IMAGE_WIDTH_CHOICES],
      [DEFAULT_TIMELINE_SETTINGS.avifQuality, TIMELINE_QUALITY_CHOICES],
      [DEFAULT_TIMELINE_SETTINGS.maxSourceImageBytes, TIMELINE_SOURCE_BYTES_CHOICES]
    ]
    for (const [value, items] of pairs) {
      expect(items.some(i => i.value === value), String(value)).toBe(true)
    }
  })
})
