// @vitest-environment jsdom
// 用到 DOMPurify（与 happy-dom 不兼容，见 useSafeHtml.test.ts 的说明）与 CSSOM 的
// aspect-ratio / min() 解析 —— jsdom 与浏览器一致，happy-dom 不保证
import { describe, it, expect } from 'vitest'
import { applyResponsiveIframeSizing } from '../../utils/iframeSizing'
import { sanitizeEntryHtml } from '../../composables/useSafeHtml'

/** 造一个与净化输出同形的 iframe（属性 + 内联样式） */
function makeIframe(attrs: Record<string, string> = {}, style = ''): HTMLIFrameElement {
  const el = document.createElement('iframe')
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  if (style) el.setAttribute('style', style)
  return el
}

/** 从净化结果里取回 iframe（字符串断言会被 data-* 之类干扰） */
function parseIframe(html: string): HTMLIFrameElement | null {
  return new DOMParser().parseFromString(html, 'text/html').querySelector('iframe')
}

describe('applyResponsiveIframeSizing', () => {
  it('width/height 属性换算成比例，宽度取「声明值与容器的较小者」', () => {
    const el = makeIframe({ width: '800', height: '500' })
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('800 / 500')
    expect(el.style.width).toBe('min(800px, 100%)')
    expect(el.style.maxWidth).toBe('100%')
    // auto 高度 + 比例：宽度缩到容器宽时高度等比缩小，播放器不会被拍扁成 150px 横条
    expect(el.style.height).toBe('auto')
    expect(el.style.boxSizing).toBe('border-box')
  })

  it('尺寸写成内联样式（style="width:800px;height:450px"）时同样换算', () => {
    const el = makeIframe({}, 'width:800px;height:450px')
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('800 / 450')
    expect(el.style.width).toBe('min(800px, 100%)')
  })

  it('尺寸带 px 后缀或大写也能读', () => {
    const el = makeIframe({ width: '560px', height: '315PX' })
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('560 / 315')
  })

  it('否定式：写 !important，压过源站同样带 !important 的内联尺寸', () => {
    const el = makeIframe({}, 'width:800px !important;height:450px !important')
    applyResponsiveIframeSizing(el)

    expect(el.style.getPropertyPriority('width')).toBe('important')
    expect(el.style.getPropertyPriority('height')).toBe('important')
    expect(el.style.getPropertyPriority('aspect-ratio')).toBe('important')
  })

  it('没有宽高声明时只兜宽度，不替源站猜比例', () => {
    // 无比例时 height:auto 会塌成 150px，所以高度必须原样留着
    const el = makeIframe({}, 'height:600px')
    applyResponsiveIframeSizing(el)

    expect(el.style.width).toBe('')
    expect(el.style.aspectRatio).toBe('')
    expect(el.style.height).toBe('600px')
    expect(el.style.maxWidth).toBe('100%')
    expect(el.style.boxSizing).toBe('border-box')
  })

  it('宽度是百分比、calc() 等非像素值时不当成 px 处理', () => {
    for (const width of ['100%', 'calc(100% - 2rem)', '50vw', 'auto']) {
      const el = makeIframe({ width, height: '400' })
      applyResponsiveIframeSizing(el)
      expect(el.style.width).toBe('')
      expect(el.style.aspectRatio).toBe('')
    }
  })

  it('拒绝 0 与负数（会算出退化的比例）', () => {
    const el = makeIframe({ width: '0', height: '500' })
    applyResponsiveIframeSizing(el)
    expect(el.style.aspectRatio).toBe('')
    expect(el.style.width).toBe('')
  })
})

describe('sanitizeEntryHtml 给 iframe 补响应式尺寸', () => {
  const context = {
    siteUrl: 'https://example.com',
    entryUrl: 'https://example.com/post/1'
  }

  it('与订阅源同源的视频嵌入带上了比例与宽度上限', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="https://example.com/player.html" width="800" height="500"></iframe>',
      context
    )
    const frame = parseIframe(out)!
    expect(frame.style.aspectRatio).toBe('800 / 500')
    expect(frame.style.width).toBe('min(800px, 100%)')
    expect(frame.style.maxWidth).toBe('100%')
    // 原有的懒加载不受影响
    expect(frame.getAttribute('loading')).toBe('lazy')
  })

  it('白名单里的第三方播放器同样处理（手机端最常见的那条路径）', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="//player.bilibili.com/player.html?bvid=BV1xx" width="1080" height="608" allowfullscreen></iframe>',
      { ...context, urlPrefixes: ['https://player.bilibili.com/player.html'] }
    )
    const frame = parseIframe(out)!
    expect(frame.style.aspectRatio).toBe('1080 / 608')
    expect(frame.hasAttribute('allowfullscreen')).toBe(true)
  })

  it('没有尺寸的嵌入不被强行撑满一行', () => {
    const out = sanitizeEntryHtml('<iframe src="https://example.com/player.html"></iframe>', context)
    const frame = parseIframe(out)!
    expect(frame.style.width).toBe('')
    expect(frame.style.aspectRatio).toBe('')
  })
})
