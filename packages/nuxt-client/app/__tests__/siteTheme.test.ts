import { describe, it, expect } from 'vitest'
import {
  PRIMARY_SHADES,
  SITE_PRIMARY_STYLE_ID,
  applyPrimaryColor,
  buildPrimaryColorCss,
  normalizeHexColor
} from '../utils/siteTheme'

describe('normalizeHexColor', () => {
  it('保留 #rrggbb 并统一为小写', () => {
    expect(normalizeHexColor('#C4FE58')).toBe('#c4fe58')
  })

  it('#rgb 展开为 #rrggbb', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc')
  })

  it('去除首尾空白', () => {
    expect(normalizeHexColor('  #059669  ')).toBe('#059669')
  })

  it('非法输入返回 null', () => {
    for (const bad of ['', 'green', '#12', '#12345', '#gggggg', 'rgb(1,2,3)']) {
      expect(normalizeHexColor(bad)).toBeNull()
    }
  })
})

describe('buildPrimaryColorCss', () => {
  it('非法颜色返回 null（调用方据此回退默认主题）', () => {
    expect(buildPrimaryColorCss('not-a-color')).toBeNull()
  })

  it('500 使用原始颜色，其余色阶用 color-mix 派生', () => {
    const css = buildPrimaryColorCss('#c4fe58')!
    expect(css).toContain('--ui-color-primary-500: #c4fe58;')
    expect(css).toContain('--ui-color-primary-50: color-mix(in oklab, #c4fe58 7%, white);')
    expect(css).toContain('--ui-color-primary-950: color-mix(in oklab, #c4fe58 40%, black);')
  })

  it('覆盖全部 11 个色阶，且选择器覆盖明暗两种模式', () => {
    const css = buildPrimaryColorCss('#059669')!
    for (const shade of PRIMARY_SHADES) {
      expect(css).toContain(`--ui-color-primary-${shade}:`)
    }
    expect(css).toMatch(/^:root, :host, \.light, \.dark \{/)
  })

  it('#rgb 简写同样可用', () => {
    const css = buildPrimaryColorCss('#abc')!
    expect(css).toContain('--ui-color-primary-500: #aabbcc;')
  })
})

describe('applyPrimaryColor', () => {
  it('写入 <style> 并包含配置色，重复调用只更新同一个元素', () => {
    applyPrimaryColor(document, '#c4fe58')
    const first = document.getElementById(SITE_PRIMARY_STYLE_ID) as HTMLStyleElement
    expect(first).toBeTruthy()
    expect(first.textContent).toContain('--ui-color-primary-500: #c4fe58;')

    applyPrimaryColor(document, '#059669')
    const second = document.getElementById(SITE_PRIMARY_STYLE_ID) as HTMLStyleElement
    expect(second).toBe(first)
    expect(second.textContent).toContain('--ui-color-primary-500: #059669;')
    expect(document.querySelectorAll(`#${SITE_PRIMARY_STYLE_ID}`)).toHaveLength(1)
  })

  it('未配置或非法颜色时移除覆写，回退默认主题', () => {
    applyPrimaryColor(document, '#c4fe58')
    applyPrimaryColor(document, null)
    expect(document.getElementById(SITE_PRIMARY_STYLE_ID)).toBeNull()

    applyPrimaryColor(document, '#c4fe58')
    applyPrimaryColor(document, 'not-a-color')
    expect(document.getElementById(SITE_PRIMARY_STYLE_ID)).toBeNull()
  })
})
