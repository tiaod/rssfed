import { describe, expect, it } from 'vitest'
import { resolveInternalPath } from '~/utils/redirectTarget'

describe('resolveInternalPath', () => {
  it('保留站内绝对路径', () => {
    expect(resolveInternalPath('/timeline')).toBe('/timeline')
    expect(resolveInternalPath('/rss/feed/123?foo=1#bar')).toBe('/rss/feed/123?foo=1#bar')
  })

  it('拒绝协议相对地址与外站地址', () => {
    // 这两个都会被浏览器当作外站地址解析，登录回跳不能变成开放重定向
    expect(resolveInternalPath('//evil.example.com')).toBe('/timeline')
    expect(resolveInternalPath('/\\evil.example.com')).toBe('/timeline')
    expect(resolveInternalPath('https://evil.example.com')).toBe('/timeline')
  })

  it('非字符串与缺省值回退', () => {
    expect(resolveInternalPath(undefined)).toBe('/timeline')
    expect(resolveInternalPath(null)).toBe('/timeline')
    expect(resolveInternalPath(['/timeline'])).toBe('/timeline')
    expect(resolveInternalPath(null, '/')).toBe('/')
  })
})
