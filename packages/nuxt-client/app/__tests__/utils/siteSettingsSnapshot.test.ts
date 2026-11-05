import { describe, it, expect, beforeEach } from 'vitest'
import {
  SITE_SETTINGS_SNAPSHOT_KEY,
  readSiteSettingsSnapshot,
  sanitizeSiteSettingsSnapshot,
  writeSiteSettingsSnapshot
} from '../../utils/siteSettingsSnapshot'

describe('sanitizeSiteSettingsSnapshot', () => {
  it('只保留渲染会用到的公开字段', () => {
    const snapshot = sanitizeSiteSettingsSnapshot({
      siteTitle: '  RSSFed  ',
      logoUrl: '/api/files/site/logo.png',
      primaryColor: '#c4fe58',
      // 安全策略不由可篡改的本地存储恢复
      iframeWhitelist: ['https://evil.example'],
      // 不认识的字段一律丢弃
      token: 'secret'
    })!

    expect(snapshot.siteTitle).toBe('RSSFed')
    expect(snapshot.logoUrl).toBe('/api/files/site/logo.png')
    expect(snapshot.primaryColor).toBe('#c4fe58')
    expect(snapshot.iframeWhitelist).toBeUndefined()
    expect((snapshot as Record<string, unknown>).token).toBeUndefined()
  })

  it('null 有语义（管理员已清空），必须保留而不是当作缺省', () => {
    const snapshot = sanitizeSiteSettingsSnapshot({ logoUrl: null })!
    expect(snapshot.logoUrl).toBeNull()
  })

  it('空白字符串归一化为 null；无可用字段或非法输入返回 null', () => {
    expect(sanitizeSiteSettingsSnapshot({ siteTitle: '   ' })!.siteTitle).toBeNull()
    expect(sanitizeSiteSettingsSnapshot({ siteTitle: 42 })).toBeNull()
    expect(sanitizeSiteSettingsSnapshot(null)).toBeNull()
    expect(sanitizeSiteSettingsSnapshot('not-an-object')).toBeNull()
  })
})

describe('站点配置快照读写', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('写入后可读回；配置被清空时删除快照', () => {
    writeSiteSettingsSnapshot({ primaryColor: '#059669', siteTitle: '站点' }, localStorage)
    expect(readSiteSettingsSnapshot(localStorage)).toMatchObject({
      primaryColor: '#059669',
      siteTitle: '站点'
    })

    writeSiteSettingsSnapshot({}, localStorage)
    expect(localStorage.getItem(SITE_SETTINGS_SNAPSHOT_KEY)).toBeNull()
    expect(readSiteSettingsSnapshot(localStorage)).toBeNull()
  })

  it('存储里的脏数据被清洗或整体丢弃', () => {
    localStorage.setItem(SITE_SETTINGS_SNAPSHOT_KEY, 'not-json')
    expect(readSiteSettingsSnapshot(localStorage)).toBeNull()

    localStorage.setItem(SITE_SETTINGS_SNAPSHOT_KEY, JSON.stringify({ siteTitle: 1, logoUrl: '  ' }))
    expect(readSiteSettingsSnapshot(localStorage)).toEqual({ logoUrl: null })
  })
})
