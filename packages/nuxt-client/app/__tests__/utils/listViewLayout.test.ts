import { describe, it, expect } from 'vitest'
import {
  resolveLanes,
  TABLE_ROW_HEIGHT,
  VIEW_BREAKPOINTS,
  VIEW_GAP
} from '../../utils/listViewLayout'
import { LIST_VIEWS } from '../../utils/listViews'

/**
 * 列数断点表被两处消费：真实列表（虚拟化的 lanes，决定条目落哪一列）与首屏骨架（网格铺几列）。
 * 两边各写一套数字就会「骨架单列、条目三列」地跳版，所以这张表是共享的，边界值在这里钉住。
 */

/** 任务里点名的几条边界：手机 / 平板 / 桌面 / 各扩展断点 */
const WIDTHS = [0, 768, 1280, 1536, 1792, 2560]

describe('resolveLanes 列数断点', () => {
  it('社交动态 / 列表 / 表格恒为单列，视口多大都一样', () => {
    for (const width of WIDTHS) {
      expect(resolveLanes(width, 'social'), `social @${width}`).toBe(1)
      expect(resolveLanes(width, 'list'), `list @${width}`).toBe(1)
      // 表格走 Table 分支、不用泳道虚拟化，这里只为枚举完整
      expect(resolveLanes(width, 'table'), `table @${width}`).toBe(1)
    }
  })

  it('瀑布流：手机两列，平板起按断点加列直到 8 列', () => {
    const expected: Array<[number, number]> = [
      [0, 2], // 手机就给两列（卡片窄但信息密度高）
      [390, 2],
      [767, 2], // 差一像素还没到 md
      [768, 3], // md：平板
      [1280, 4], // xl
      [1536, 5], // 2xl
      [1792, 6], // 3xl
      [2560, 8] // 4xl
    ]
    for (const [width, lanes] of expected) {
      expect(resolveLanes(width, 'masonry'), `masonry @${width}`).toBe(lanes)
    }
  })

  it('博客文章：手机单列，到平板 / 桌面才铺多列', () => {
    const expected: Array<[number, number]> = [
      [0, 1],
      [767, 1], // 单列/多列的边界是 768，不是 sm(640)
      [768, 2], // md
      [1280, 3], // xl
      [1536, 3], // 2xl 不再加列：卡片要留大留白
      [2560, 3]
    ]
    for (const [width, lanes] of expected) {
      expect(resolveLanes(width, 'blog'), `blog @${width}`).toBe(lanes)
    }
  })

  it('图片瀑布流：图块窄，手机两列，lg 起才三列', () => {
    const expected: Array<[number, number]> = [
      [0, 2],
      [1023, 2],
      [1024, 3], // lg
      [1280, 4], // xl
      [1536, 5], // 2xl
      [2560, 5] // 没有更高一档
    ]
    for (const [width, lanes] of expected) {
      expect(resolveLanes(width, 'image'), `image @${width}`).toBe(lanes)
    }
  })

  it('每个视图都有断点表，且首档从 0 起（任何宽度都解析得出）', () => {
    for (const view of LIST_VIEWS) {
      const table = VIEW_BREAKPOINTS[view]
      expect(table.length, view).toBeGreaterThan(0)
      // 最后一档必须覆盖 0，否则窄屏会落到 resolveLanes 的兜底分支上
      expect(table.at(-1)![0], view).toBe(0)
    }
  })

  it('断点表按 minWidth 降序排列（首个命中生效的前提）', () => {
    for (const view of LIST_VIEWS) {
      const widths = VIEW_BREAKPOINTS[view].map(([minWidth]) => minWidth)
      expect(widths, view).toEqual([...widths].sort((a, b) => b - a))
    }
  })

  it('列数恒为正整数（网格 repeat() 与泳道分配都要求）', () => {
    for (const view of LIST_VIEWS) {
      for (const width of [...WIDTHS, 100, 3000]) {
        const lanes = resolveLanes(width, view)
        expect(Number.isInteger(lanes), `${view} @${width}`).toBe(true)
        expect(lanes, `${view} @${width}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('VIEW_GAP 条目间距', () => {
  it('靠分隔线划分的视图间距为 0（列表 / 表格 / 社交动态）', () => {
    expect(VIEW_GAP.list).toBe(0)
    expect(VIEW_GAP.table).toBe(0)
    expect(VIEW_GAP.social).toBe(0)
  })

  it('多列卡片视图都有正间距，博客比瀑布流松、图片最紧', () => {
    expect(VIEW_GAP.masonry).toBe(16)
    expect(VIEW_GAP.blog).toBe(24)
    expect(VIEW_GAP.image).toBe(8)
    expect(VIEW_GAP.blog).toBeGreaterThan(VIEW_GAP.masonry)
    expect(VIEW_GAP.image).toBeLessThan(VIEW_GAP.masonry)
  })

  it('每个视图都有一份间距（模板直接按 view 取，缺一项就是 undefined → "undefinedpx"）', () => {
    for (const view of LIST_VIEWS) {
      expect(typeof VIEW_GAP[view], view).toBe('number')
    }
  })
})

describe('TABLE_ROW_HEIGHT 表格行高', () => {
  it('是一行 text-sm + py-2 内边距 + 1px 分隔线（37），不是主题默认 p-4 的 53', () => {
    // UTable 不逐行测量：tr 直接被写成这个高度，所以它必须与单元格实际渲染高度一致
    expect(TABLE_ROW_HEIGHT).toBe(37)
  })
})
