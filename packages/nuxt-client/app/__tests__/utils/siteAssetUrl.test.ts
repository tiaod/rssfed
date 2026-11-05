import { describe, it, expect } from 'vitest'
import { sameOriginAssetUrl } from '../../utils/siteAssetUrl'

describe('sameOriginAssetUrl', () => {
  it('同源相对路径原样返回', () => {
    expect(sameOriginAssetUrl('/api/files/site/logo.png')).toBe('/api/files/site/logo.png')
  })

  it('跨源绝对地址里的文件代理路径改走同源', () => {
    expect(sameOriginAssetUrl('https://cdn.example.com/api/files/site/logo.png'))
      .toBe('/api/files/site/logo.png')
    expect(sameOriginAssetUrl('//cdn.example.com/api/files/x.png?v=1'))
      .toBe('/api/files/x.png?v=1')
  })

  it('非文件代理的外链保持原样', () => {
    expect(sameOriginAssetUrl('https://example.com/logo.png'))
      .toBe('https://example.com/logo.png')
  })

  it('空值返回 null', () => {
    expect(sameOriginAssetUrl(null)).toBeNull()
    expect(sameOriginAssetUrl(undefined)).toBeNull()
    expect(sameOriginAssetUrl('   ')).toBeNull()
  })
})
