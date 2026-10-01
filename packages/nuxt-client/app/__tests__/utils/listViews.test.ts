import { describe, it, expect } from 'vitest'
import {
  LIST_VIEWS,
  LIST_VIEW_OPTIONS,
  LIST_VIEW_META,
  DEFAULT_LIST_VIEW,
  isListView
} from '../../utils/listViews'

describe('列表视图枚举', () => {
  it('默认视图是瀑布流（保持加视图之前的行为）', () => {
    expect(DEFAULT_LIST_VIEW).toBe('masonry')
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
    expect(isListView('grid')).toBe(false) // 老版本存储 / 手改文档里的非法值
    expect(isListView('')).toBe(false)
    expect(isListView(null)).toBe(false)
    expect(isListView(undefined)).toBe(false)
    expect(isListView(3)).toBe(false)
  })
})
