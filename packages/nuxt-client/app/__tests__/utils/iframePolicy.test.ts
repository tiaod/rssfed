import { describe, it, expect } from 'vitest'
import { buildIframePolicy, resolveIframeSrc } from '../../utils/iframePolicy'

const YT_PREFIX = 'https://www.youtube.com/embed/'

/** 常用策略：订阅源站点 example.com，管理员白名单放行 YouTube 播放器 */
function makePolicy(overrides: Partial<Parameters<typeof buildIframePolicy>[0]> = {}) {
  return buildIframePolicy({
    siteUrl: 'https://example.com',
    feedUrl: 'https://example.com/rss.xml',
    entryUrl: 'https://example.com/post/1',
    urlPrefixes: [YT_PREFIX],
    ...overrides
  }, 'https://reader.test')
}

describe('resolveIframeSrc', () => {
  it('与订阅源同源的绝对地址放行', () => {
    expect(resolveIframeSrc('https://example.com/player.html', makePolicy()))
      .toBe('https://example.com/player.html')
  })

  it('相对地址按条目原文地址解析成绝对地址', () => {
    expect(resolveIframeSrc('/player.html', makePolicy()))
      .toBe('https://example.com/player.html')
    // 不带前导斜杠的相对地址以条目原文的目录为基准（与浏览器同一套 URL 语义）
    expect(resolveIframeSrc('player.html', makePolicy()))
      .toBe('https://example.com/post/player.html')
  })

  it('协议相对地址补全成 https', () => {
    expect(resolveIframeSrc('//www.youtube.com/embed/abc', makePolicy()))
      .toBe('https://www.youtube.com/embed/abc')
  })

  it('命中白名单前缀时大小写不敏感', () => {
    expect(resolveIframeSrc('https://WWW.YouTube.com/embed/abc', makePolicy()))
      .toBe('https://www.youtube.com/embed/abc')
  })

  it('只有前缀相同才放行，路径不同的 YouTube 页面不放行', () => {
    expect(resolveIframeSrc('https://www.youtube.com/watch?v=abc', makePolicy())).toBeNull()
  })

  it('不在白名单里的第三方地址不放行', () => {
    expect(resolveIframeSrc('https://evil.example/login', makePolicy())).toBeNull()
  })

  it('javascript: / data: 等协议一律拒绝', () => {
    const policy = buildIframePolicy({
      entryUrl: 'https://example.com/post/1',
      urlPrefixes: ['https://example.com/']
    }, 'https://reader.test')

    expect(resolveIframeSrc('javascript:alert(1)', policy)).toBeNull()
    expect(resolveIframeSrc('data:text/html,<b>x</b>', policy)).toBeNull()
  })

  it('阅读器自身 origin 永不放行（哪怕命中白名单）', () => {
    const policy = buildIframePolicy({
      entryUrl: 'https://reader.test/post/1',
      urlPrefixes: ['https://reader.test/']
    }, 'https://reader.test')

    expect(resolveIframeSrc('https://reader.test/admin', policy)).toBeNull()
    expect(resolveIframeSrc('/admin', policy)).toBeNull()
  })

  it('缺少 src 或地址非法时拒绝', () => {
    expect(resolveIframeSrc('', makePolicy())).toBeNull()
    expect(resolveIframeSrc(null, makePolicy())).toBeNull()
    expect(resolveIframeSrc('   ', makePolicy())).toBeNull()
    // 没有 base 时相对地址无法解析
    expect(resolveIframeSrc('/player.html', buildIframePolicy({ urlPrefixes: [] }))).toBeNull()
  })

  it('没有 base 也能判定绝对地址', () => {
    const policy = buildIframePolicy({ urlPrefixes: [YT_PREFIX] })
    expect(resolveIframeSrc(`${YT_PREFIX}abc`, policy)).toBe(`${YT_PREFIX}abc`)
  })
})

describe('buildIframePolicy', () => {
  it('订阅源站点/源地址/条目地址的 origin 都会参与同源判定且去重', () => {
    const policy = makePolicy()
    expect(policy.feedOrigins).toEqual(['https://example.com'])
  })

  it('把阅读器自身 origin 从同源集合里剔除', () => {
    const policy = buildIframePolicy({
      siteUrl: 'https://reader.test',
      entryUrl: 'https://reader.test/post/1'
    }, 'https://reader.test')
    expect(policy.feedOrigins).toEqual([])
  })

  it('丢弃非法白名单条目，保留合法前缀', () => {
    const policy = buildIframePolicy({
      urlPrefixes: ['javascript:alert(1)', 'not a url', YT_PREFIX, YT_PREFIX.toUpperCase()]
    })
    expect(policy.urlPrefixes).toEqual([YT_PREFIX])
  })

  it('base 优先用条目原文地址，缺失时逐级回退', () => {
    expect(makePolicy().base).toBe('https://example.com/post/1')
    expect(buildIframePolicy({ siteUrl: 'https://example.com' }).base).toBe('https://example.com')
  })
})
