import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READER_FONT_ID,
  READER_FONTS,
  isReaderFontId,
  loadReaderFontCss,
  normalizeReaderFontId,
  readerFontCssEntry,
  readerFontStack,
  resolveReaderFont
} from '../../utils/readerFonts'

describe('阅读字体清单', () => {
  it('id 唯一，且默认项在清单里', () => {
    const ids = READER_FONTS.map(font => font.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_READER_FONT_ID)
  })

  it('除「跟随系统」外，每套字体栈都以通用族兜底', () => {
    // 浏览器拿不到本机装了哪些字体，缺族时会按栈往下走 ——
    // 末尾没有 serif/sans-serif 兜底就会落到浏览器默认字体，观感不可控
    for (const font of READER_FONTS) {
      if (font.stack === null) continue
      expect(font.stack).toMatch(/(?:^|, )\s*(?:serif|sans-serif)$/)
    }
  })

  it('只有「跟随系统」不带字体栈', () => {
    expect(readerFontStack('inherit')).toBeNull()
    expect(READER_FONTS.filter(font => font.stack === null).map(font => font.id)).toEqual(['inherit'])
  })

  it('自带字体用 GB 字形族名，且声明了按需加载入口', () => {
    expect(readerFontStack('wenkai')).toContain('LXGW WenKai GB Screen')
    expect(readerFontCssEntry('wenkai')).toBe('lxgw-wenkai-screen-web/lxgwwenkaigbscreen/result.css')
  })

  it('系统字体不需要加载 CSS', () => {
    for (const id of ['inherit', 'sans', 'serif', 'kai']) {
      expect(readerFontCssEntry(id)).toBeNull()
    }
  })
})

describe('normalizeReaderFontId', () => {
  it('接受清单内的 id', () => {
    for (const font of READER_FONTS) {
      expect(normalizeReaderFontId(font.id)).toBe(font.id)
    }
  })

  it('脏值一律回退默认，不抛错（否则设置页会整页打不开）', () => {
    expect(normalizeReaderFontId(undefined)).toBe(DEFAULT_READER_FONT_ID)
    expect(normalizeReaderFontId(null)).toBe(DEFAULT_READER_FONT_ID)
    expect(normalizeReaderFontId('')).toBe(DEFAULT_READER_FONT_ID)
    expect(normalizeReaderFontId('comfortaa')).toBe(DEFAULT_READER_FONT_ID)
    expect(normalizeReaderFontId(42)).toBe(DEFAULT_READER_FONT_ID)
    expect(normalizeReaderFontId({ id: 'wenkai' })).toBe(DEFAULT_READER_FONT_ID)
  })

  it('isReaderFontId 只认清单内的字符串', () => {
    expect(isReaderFontId('wenkai')).toBe(true)
    expect(isReaderFontId('WENKAI')).toBe(false)
    expect(isReaderFontId(undefined)).toBe(false)
  })

  it('未知 id 解析出来的就是默认条目', () => {
    expect(resolveReaderFont('nope')).toBe(resolveReaderFont(DEFAULT_READER_FONT_ID))
  })
})

describe('loadReaderFontCss', () => {
  it('系统字体直接返回，不触发任何加载', async () => {
    await expect(loadReaderFontCss('inherit')).resolves.toBeUndefined()
    await expect(loadReaderFontCss(undefined)).resolves.toBeUndefined()
  })

  it('自带字体能加载到样式（分片由浏览器按 unicode-range 按需下载）', async () => {
    // 这条用例的作用是钉住「依赖路径可解析」：打包后这条动态 import 必须真的能拿到 CSS，
    // 否则插件会吞掉异常、正文只剩回退字体（线上表现为"选了没反应"）
    await expect(loadReaderFontCss('wenkai')).resolves.toBeUndefined()
  })
})
