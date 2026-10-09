import { describe, expect, it } from 'vitest'
import { LEGACY_LOCAL_DB_NAMES, LEGACY_LOCAL_DB_PREFIXES, lastTimelineRefreshKey, localDbName } from '~/utils/localDbName'

describe('localDbName', () => {
  it('按账号隔离：不同账号的本地库名不同', () => {
    expect(localDbName('timeline', 'user-a')).toBe('rssfed-timeline-user-a')
    expect(localDbName('timeline', 'user-b')).toBe('rssfed-timeline-user-b')
    expect(localDbName('user-state', 'user-a')).toBe('rssfed-user-state-user-a')
  })

  it('两类本地库不会撞名', () => {
    expect(localDbName('timeline', 'u1')).not.toBe(localDbName('user-state', 'u1'))
  })

  it('未登录/会话未就绪落到 guest', () => {
    for (const value of [null, undefined, '']) {
      expect(localDbName('timeline', value)).toBe('rssfed-timeline-guest')
      expect(localDbName('user-state', value)).toBe('rssfed-user-state-guest')
    }
  })

  it('隔离后的库名与旧的固定库名不同（否则清理逻辑会删掉正在用的库）', () => {
    for (const legacy of LEGACY_LOCAL_DB_NAMES) {
      expect(localDbName('timeline', null)).not.toBe(legacy)
      expect(localDbName('user-state', null)).not.toBe(legacy)
      expect(localDbName('timeline', 'u1')).not.toBe(legacy)
      expect(localDbName('user-state', 'u1')).not.toBe(legacy)
    }
  })

  it('当前库名不会被历史前缀误伤（清理逻辑按前缀删库）', () => {
    for (const prefix of LEGACY_LOCAL_DB_PREFIXES) {
      expect(localDbName('timeline', 'u1').startsWith(prefix)).toBe(false)
      expect(localDbName('user-state', 'u1').startsWith(prefix)).toBe(false)
    }
  })
})

describe('lastTimelineRefreshKey', () => {
  it('催促时间同样按账号隔离（否则 A 的催促会让 B 的页面不再催）', () => {
    expect(lastTimelineRefreshKey('user-a')).toBe('rssfed-timeline-refresh-user-a')
    expect(lastTimelineRefreshKey('user-a')).not.toBe(lastTimelineRefreshKey('user-b'))
    expect(lastTimelineRefreshKey(null)).toBe('rssfed-timeline-refresh-guest')
  })
})
