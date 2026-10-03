import { describe, it, expect } from 'vitest'
import {
  LIST_VIEWS,
  LIST_VIEW_OPTIONS,
  LIST_VIEW_META,
  DEFAULT_LIST_VIEW,
  TIMELINE_DEFAULT_VIEW,
  isListView
} from '../../utils/listViews'

describe('列表视图枚举', () => {
  it('兜底视图是瀑布流（保持加视图之前的行为）', () => {
    expect(DEFAULT_LIST_VIEW).toBe('masonry')
  })

  it('时间线的内置默认是社交动态，且只作用于时间线', () => {
    expect(TIMELINE_DEFAULT_VIEW).toBe('social')
    expect(LIST_VIEWS).toContain(TIMELINE_DEFAULT_VIEW)
    // 两者是两件事：全局 / 其它页面兜底没有跟着变，见 useTimelineView 与 useSettings
    expect(TIMELINE_DEFAULT_VIEW).not.toBe(DEFAULT_LIST_VIEW)
  })

  it('每个视图都有显示名、图标与说明', () => {
    for (const view of LIST_VIEWS) {
      expect(LIST_VIEW_META[view].label).toBeTruthy()
      expect(LIST_VIEW_META[view].icon).toMatch(/^i-lucide-/)
      expect(LIST_VIEW_META[view].description).toBeTruthy()
    }
  })

  it('设置页的选项覆盖全部视图，value 与枚举顺序一致', () => {
    expect(LIST_VIEW_OPTIONS.map(o => o.value)).toEqual([...LIST_VIEWS])
  })

  it('isListView 只接受枚举内的字符串', () => {
    expect(isListView('blog')).toBe(true)
    expect(isListView('social')).toBe(true)
    expect(isListView('grid')).toBe(false) // 老版本存储 / 手改文档里的非法值
    expect(isListView('')).toBe(false)
    expect(isListView(null)).toBe(false)
    expect(isListView(undefined)).toBe(false)
    expect(isListView(3)).toBe(false)
  })
})
