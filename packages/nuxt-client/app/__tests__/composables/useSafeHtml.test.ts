// @vitest-environment jsdom
// 必须用 jsdom：DOMPurify 与 happy-dom 不兼容，在 happy-dom 下会把 table/pre/figure
// 误删、又放过 input/style，净化断言全部失真（vitest 全局环境是 happy-dom）。
import { describe, it, expect } from 'vitest'
import { sanitizeEntryHtml, useSafeHtml } from '../../composables/useSafeHtml'
import { ref } from 'vue'

describe('sanitizeEntryHtml', () => {
  it('剥离 <script> 但保留正常正文', () => {
    const out = sanitizeEntryHtml('<p>正文</p><script>alert(1)</script>')
    expect(out).toContain('正文')
    expect(out).not.toContain('script')
  })

  it('剥离 on* 事件属性（<img onerror>）', () => {
    const out = sanitizeEntryHtml('<img src="https://a/b.png" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
    expect(out).toContain('https://a/b.png')
  })

  it('剥离 javascript: 协议链接', () => {
    const out = sanitizeEntryHtml('<a href="javascript:alert(1)">点我</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('点我')
  })

  it('外链统一补 target=_blank 与 rel=noopener', () => {
    const out = sanitizeEntryHtml('<a href="https://example.com/post">外链</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('图片补懒加载与 no-referrer', () => {
    const out = sanitizeEntryHtml('<img src="https://a/b.png">')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('decoding="async"')
    expect(out).toContain('referrerpolicy="no-referrer"')
  })

  it('保留 RSS 常见结构（figure/figcaption/table/pre）', () => {
    const out = sanitizeEntryHtml(
      '<figure><img src="https://a/b.png"><figcaption>图注</figcaption></figure>'
      + '<table><tr><td>单元格</td></tr></table>'
      + '<pre><code>const a = 1</code></pre>'
    )
    expect(out).toContain('<figure>')
    expect(out).toContain('<figcaption>')
    expect(out).toContain('<table>')
    expect(out).toContain('<pre>')
  })

  it('禁掉表单类标签与 <style>（防钓鱼/防污染阅读器样式）', () => {
    const out = sanitizeEntryHtml(
      '<form action="/steal"><input name="password"></form><style>body{display:none}</style>'
    )
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<input')
    expect(out).not.toContain('<style')
  })

  it('默认不放行 iframe 嵌入', () => {
    const out = sanitizeEntryHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>')
    expect(out).not.toContain('iframe')
  })

  it('空值返回空串', () => {
    expect(sanitizeEntryHtml(undefined)).toBe('')
    expect(sanitizeEntryHtml(null)).toBe('')
    expect(sanitizeEntryHtml('')).toBe('')
  })
})

describe('useSafeHtml', () => {
  it('随 source 变化重新净化', () => {
    const content = ref('<p>第一版</p><script>bad()</script>')
    const safe = useSafeHtml(content)

    expect(safe.value).toContain('第一版')
    expect(safe.value).not.toContain('script')

    content.value = '<p>第二版</p>'
    expect(safe.value).toContain('第二版')
    expect(safe.value).not.toContain('第一版')
  })
})
