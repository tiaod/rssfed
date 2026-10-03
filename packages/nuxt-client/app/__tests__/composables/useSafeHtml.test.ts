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

describe('sanitizeEntryHtml 的 iframe 策略', () => {
  /** 订阅源站点 example.com + 管理员白名单放行 YouTube 播放器 */
  const context = {
    siteUrl: 'https://example.com',
    feedUrl: 'https://example.com/rss.xml',
    entryUrl: 'https://example.com/post/1',
    urlPrefixes: ['https://www.youtube.com/embed/']
  }

  it('放行与订阅源同源的嵌入', () => {
    const out = sanitizeEntryHtml('<iframe src="https://example.com/player.html"></iframe>', context)
    expect(out).toContain('<iframe')
    expect(out).toContain('src="https://example.com/player.html"')
  })

  it('相对地址改写成订阅源的绝对地址（否则浏览器会嵌入阅读器自己）', () => {
    const out = sanitizeEntryHtml('<iframe src="/player.html"></iframe>', context)
    expect(out).toContain('src="https://example.com/player.html"')
  })

  it('放行白名单里的播放器地址并补懒加载', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="//www.youtube.com/embed/abc" width="560" height="315" allowfullscreen></iframe>',
      context
    )
    expect(out).toContain('src="https://www.youtube.com/embed/abc"')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('allowfullscreen')
  })

  it('丢弃不在白名单里的第三方嵌入，正文其余部分保留', () => {
    const out = sanitizeEntryHtml(
      '<p>正文</p><iframe src="https://evil.example/login"></iframe><p>结尾</p>',
      context
    )
    expect(out).toContain('正文')
    expect(out).toContain('结尾')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('evil.example')
  })

  it('丢弃 srcdoc 与没有 src 的 iframe', () => {
    const out = sanitizeEntryHtml(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><iframe></iframe><p>x</p>',
      context
    )
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('srcdoc')
    expect(out).toContain('x')
  })

  it('丢弃 javascript: 伪协议 iframe（即使它落在白名单前缀所在的站）', () => {
    const out = sanitizeEntryHtml('<iframe src="javascript:alert(1)"></iframe>', context)
    expect(out).not.toContain('iframe')
  })

  it('不放行阅读器自身的 origin', () => {
    const out = sanitizeEntryHtml(`<iframe src="${window.location.origin}/admin"></iframe>`, {
      entryUrl: window.location.origin,
      urlPrefixes: [`${window.location.origin}/`]
    })
    expect(out).not.toContain('iframe')
  })

  it('不在同源集合里时，订阅源之外的站不放行', () => {
    const out = sanitizeEntryHtml('<iframe src="https://other.example/player.html"></iframe>', context)
    expect(out).not.toContain('iframe')
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

  it('白名单变化后重新净化（管理员改完即时生效）', () => {
    const content = ref('<iframe src="https://v.example/embed/1"></iframe>')
    const prefixes = ref<string[]>([])
    const safe = useSafeHtml(content, () => ({
      entryUrl: 'https://example.com/post/1',
      urlPrefixes: prefixes.value
    }))

    expect(safe.value).not.toContain('iframe')

    prefixes.value = ['https://v.example/embed/']
    expect(safe.value).toContain('iframe')
  })
})
