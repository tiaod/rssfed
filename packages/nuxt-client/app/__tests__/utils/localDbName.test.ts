import { describe, expect, it } from 'vitest'
import { localDbName, syncedFeedsKey, LEGACY_LOCAL_DB_NAMES } from '~/utils/localDbName'

describe('localDbName', () => {
  it('按账号隔离：不同账号的本地库名不同', () => {
    expect(localDbName('entries', 'user-a')).toBe('rssfed-entries-user-a')
    expect(localDbName('entries', 'user-b')).toBe('rssfed-entries-user-b')
    expect(localDbName('user-state', 'user-a')).toBe('rssfed-user-state-user-a')
  })

  it('两类本地库不会撞名', () => {
    expect(localDbName('entries', 'u1')).not.toBe(localDbName('user-state', 'u1'))
  })

  it('未登录/会话未就绪落到 guest', () => {
    for (const value of [null, undefined, '']) {
      expect(localDbName('entries', value)).toBe('rssfed-entries-guest')
      expect(localDbName('user-state', value)).toBe('rssfed-user-state-guest')
    }
  })

  it('隔离后的库名与旧的固定库名不同（否则清理逻辑会删掉正在用的库）', () => {
    for (const legacy of LEGACY_LOCAL_DB_NAMES) {
      expect(localDbName('entries', null)).not.toBe(legacy)
      expect(localDbName('user-state', null)).not.toBe(legacy)
      expect(localDbName('entries', 'u1')).not.toBe(legacy)
      expect(localDbName('user-state', 'u1')).not.toBe(legacy)
    }
  })
})

describe('syncedFeedsKey', () => {
  it('增量同步记录同样按账号隔离（否则 A 的记录会让 B 跳过同步）', () => {
    expect(syncedFeedsKey('user-a')).toBe('rssfed-synced-feeds-user-a')
    expect(syncedFeedsKey('user-a')).not.toBe(syncedFeedsKey('user-b'))
    expect(syncedFeedsKey(null)).toBe('rssfed-synced-feeds-guest')
    expect(syncedFeedsKey(null)).not.toBe('rssfed-synced-feeds')
  })
})
