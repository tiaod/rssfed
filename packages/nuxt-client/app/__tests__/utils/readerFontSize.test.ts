import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READER_FONT_SCALE,
  READER_FONT_SCALE_MAX,
  READER_FONT_SCALE_MIN,
  READER_FONT_SCALE_STEP,
  isReaderFontScale,
  normalizeReaderFontScale,
  readerFontSizeCss
} from '../../utils/readerFontSize'

describe('正文字号百分比', () => {
  it('默认值在区间内，且落在步长上（滑块初始位置必须能停住）', () => {
    expect(DEFAULT_READER_FONT_SCALE).toBeGreaterThanOrEqual(READER_FONT_SCALE_MIN)
    expect(DEFAULT_READER_FONT_SCALE).toBeLessThanOrEqual(READER_FONT_SCALE_MAX)
    expect((DEFAULT_READER_FONT_SCALE - READER_FONT_SCALE_MIN) % READER_FONT_SCALE_STEP).toBe(0)
  })

  it('isReaderFontScale 只认区间内、步长上的数字', () => {
    expect(isReaderFontScale(80)).toBe(true)
    expect(isReaderFontScale(100)).toBe(true)
    expect(isReaderFontScale(160)).toBe(true)
    expect(isReaderFontScale(105)).toBe(true)
    // 区间外 / 不在步长上 / 非数字
    expect(isReaderFontScale(79)).toBe(false)
    expect(isReaderFontScale(161)).toBe(false)
    expect(isReaderFontScale(103)).toBe(false)
    expect(isReaderFontScale('100')).toBe(false)
    expect(isReaderFontScale(undefined)).toBe(false)
    expect(isReaderFontScale(Number.NaN)).toBe(false)
  })
})

describe('normalizeReaderFontScale', () => {
  it('合法值原样返回', () => {
    expect(normalizeReaderFontScale(80)).toBe(80)
    expect(normalizeReaderFontScale(115)).toBe(115)
    expect(normalizeReaderFontScale(160)).toBe(160)
  })

  it('区间外的数字夹到两端，而不是丢掉用户的调整', () => {
    expect(normalizeReaderFontScale(20)).toBe(READER_FONT_SCALE_MIN)
    expect(normalizeReaderFontScale(999)).toBe(READER_FONT_SCALE_MAX)
  })

  it('不在步长上的数字吸附到最近的步长', () => {
    expect(normalizeReaderFontScale(103)).toBe(105)
    expect(normalizeReaderFontScale(102)).toBe(100)
    expect(normalizeReaderFontScale(157)).toBe(155)
  })

  it('脏值一律回退默认，不抛错（否则设置页会整页打不开）', () => {
    expect(normalizeReaderFontScale(undefined)).toBe(DEFAULT_READER_FONT_SCALE)
    expect(normalizeReaderFontScale(null)).toBe(DEFAULT_READER_FONT_SCALE)
    expect(normalizeReaderFontScale('120')).toBe(DEFAULT_READER_FONT_SCALE)
    expect(normalizeReaderFontScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_READER_FONT_SCALE)
    expect(normalizeReaderFontScale(Number.NaN)).toBe(DEFAULT_READER_FONT_SCALE)
    expect(normalizeReaderFontScale({ scale: 120 })).toBe(DEFAULT_READER_FONT_SCALE)
  })
})

describe('readerFontSizeCss', () => {
  it('100% 返回 null：调用方移除变量，落回 CSS 的默认值', () => {
    expect(readerFontSizeCss(100)).toBeNull()
    // 没配过（undefined）与显式 100% 是同一件事，老设置不需要迁移
    expect(readerFontSizeCss(undefined)).toBeNull()
    expect(readerFontSizeCss('120')).toBeNull()
  })

  it('其它档位换算成 rem，且去掉末尾多余的 0', () => {
    expect(readerFontSizeCss(85)).toBe('0.85rem')
    expect(readerFontSizeCss(90)).toBe('0.9rem')
    expect(readerFontSizeCss(115)).toBe('1.15rem')
    expect(readerFontSizeCss(150)).toBe('1.5rem')
    expect(readerFontSizeCss(160)).toBe('1.6rem')
  })
})
