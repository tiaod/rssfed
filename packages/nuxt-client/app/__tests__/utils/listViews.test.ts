import { describe, it, expect } from 'vitest'
import {
  LIST_VIEWS,
  LIST_VIEW_OPTIONS,
  LIST_VIEW_META,
  DEFAULT_LIST_VIEW,
  TIMELINE_DEFAULT_VIEW,
  isListView,
  showsTimelineSidebar
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

  it('每个视图都有显示名与图标', () => {
    for (const view of LIST_VIEWS) {
      expect(LIST_VIEW_META[view].label).toBeTruthy()
      expect(LIST_VIEW_META[view].icon).toMatch(/^i-lucide-/)
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

/**
 * 时间线右栏（同步健康 + 阅读小结）只跟社交动态一起出现。
 *
 * 这是「哪一版能容得下一栏」的布局判断，不是权限或偏好：其余五种都是靠满宽铺密度的版式，
 * 加一栏等于把它们的列宽切掉。以后再加视图时，这个用例会逼着人明确表态而不是默认多出一栏。
 */
describe('时间线右栏的视图判据', () => {
  it('只有社交动态有右栏', () => {
    expect(showsTimelineSidebar('social')).toBe(true)
    expect(LIST_VIEWS.filter(showsTimelineSidebar)).toEqual(['social'])
  })

  it('所有枚举视图都有明确结论（表里没有漏项 / 没有未定义）', () => {
    for (const view of LIST_VIEWS) {
      expect(typeof showsTimelineSidebar(view)).toBe('boolean')
    }
  })
})
