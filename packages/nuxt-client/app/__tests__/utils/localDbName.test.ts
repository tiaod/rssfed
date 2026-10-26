import { describe, expect, it } from 'vitest'
import { LEGACY_LOCAL_DB_NAMES, LEGACY_LOCAL_DB_PREFIXES, lastTimelineCompactKey, lastTimelineRefreshKey, localDbAccountKey, localDbName, isLegacyLocalDbName, isLegacyLocalStorageKey, stripPouchNamePrefix } from '~/utils/localDbName'

describe('localDbName', () => {
  it('按账号隔离：不同账号的本地库名不同（单库方案下每账号只有一个库）', () => {
    expect(localDbName('user-a')).toBe('rssfed-timeline-user-a')
    expect(localDbName('user-b')).toBe('rssfed-timeline-user-b')
    expect(localDbName('user-a')).not.toBe(localDbName('user-b'))
  })

  it('沿用 rssfed-timeline- 前缀：改名等于换库，老用户本地的条目要整份重下', () => {
    // 这不是「碰巧」的命名，见 utils/localDbName.ts 的说明
    expect(localDbName('u1')).toBe('rssfed-timeline-u1')
  })

  it('未登录/会话未就绪落到 guest', () => {
    for (const value of [null, undefined, '']) {
      expect(localDbName(value)).toBe('rssfed-timeline-guest')
    }
  })

  it('账号隔离后的库名与旧的固定库名不同（否则清理逻辑会删掉正在用的库）', () => {
    for (const legacy of LEGACY_LOCAL_DB_NAMES) {
      expect(localDbName(null)).not.toBe(legacy)
      expect(localDbName('u1')).not.toBe(legacy)
    }
  })

  it('当前库名不会被历史前缀误伤（清理逻辑按前缀删库）', () => {
    for (const prefix of LEGACY_LOCAL_DB_PREFIXES) {
      expect(localDbName('u1').startsWith(prefix)).toBe(false)
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

describe('lastTimelineCompactKey', () => {
  it('压缩节流同样按账号隔离（否则 A 压过之后 B 一天内都不压）', () => {
    expect(lastTimelineCompactKey('user-a')).toBe('rssfed-timeline-compacted-user-a')
    expect(lastTimelineCompactKey('user-a')).not.toBe(lastTimelineCompactKey('user-b'))
    expect(lastTimelineCompactKey(null)).toBe('rssfed-timeline-compacted-guest')
  })
})

describe('localDbAccountKey', () => {
  it('与库名里的账号段是同一个定义（清理逻辑据此判断「这是不是当前账号的库」）', () => {
    expect(localDbAccountKey('user-a')).toBe('user-a')
    expect(localDbAccountKey(null)).toBe('guest')
    expect(localDbName('user-a')).toBe(`rssfed-timeline-${localDbAccountKey('user-a')}`)
  })
})

describe('历史本地库 / localStorage 键的匹配', () => {
  it('PouchDB 实际库名带 _pouch_ 前缀也能命中（升级后旧条目库确实长这样）', () => {
    expect(isLegacyLocalDbName('_pouch_rssfed-entries-2RGBxIeXa')).toBe(true)
    expect(isLegacyLocalDbName('_pouch_rssfed-feed-abc123')).toBe(true)
    expect(isLegacyLocalDbName('_pouch_rssfed-entries-2RGBxIeXa-mrview-1312fe8d')).toBe(true)
  })

  it('逻辑名（无前缀）同样命中，当前在用的那个库不命中', () => {
    expect(isLegacyLocalDbName('rssfed-entries')).toBe(true)
    expect(isLegacyLocalDbName('rssfed-feed-x')).toBe(true)
    expect(isLegacyLocalDbName('_pouch_rssfed-timeline-2RGBxIeXa')).toBe(false)
    expect(isLegacyLocalDbName('_pouch_rssfed-timeline-2RGBxIeXa-mrview-abc')).toBe(false)
  })

  it('旧的状态库（单开一个本地库的时代）也要清掉，且不带账号后缀的也命中', () => {
    expect(isLegacyLocalDbName('_pouch_rssfed-user-state-2RGBxIeXa')).toBe(true)
    expect(isLegacyLocalDbName('rssfed-user-state')).toBe(true)
  })

  it('销毁前剥掉 _pouch_ 前缀（PouchDB.destroy 会自己再加回来）', () => {
    expect(stripPouchNamePrefix('_pouch_rssfed-entries-x')).toBe('rssfed-entries-x')
    expect(stripPouchNamePrefix('rssfed-entries-x')).toBe('rssfed-entries-x')
  })

  it('旧 localStorage 键按前缀匹配，带账号后缀的也要清', () => {
    expect(isLegacyLocalStorageKey('rssfed-synced-feeds')).toBe(true)
    expect(isLegacyLocalStorageKey('rssfed-synced-feeds-2RGBxIeXa')).toBe(true)
    expect(isLegacyLocalStorageKey('rssfed-sync-window-2RGBxIeXa')).toBe(true)
  })

  it('当前在用的键不能被误删', () => {
    expect(isLegacyLocalStorageKey('rssfed-central-migrated-v5')).toBe(false)
    expect(isLegacyLocalStorageKey('rssfed-timeline-refresh-2RGBxIeXa')).toBe(false)
    // 前缀相同但不是一个键族（少了分隔符）时不能误判
    expect(isLegacyLocalStorageKey('rssfed-synced-feedsX')).toBe(false)
  })
})
