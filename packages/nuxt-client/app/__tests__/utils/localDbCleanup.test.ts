import { describe, it, expect, afterEach } from 'vitest'
import {
  countAccountsOfDbs,
  deleteLocalDbs,
  isOtherAccountTimelineDb,
  listActualDbNames,
  pickOtherAccountTimelineDbs,
  timelineDbAccount
} from '~/utils/localDbCleanup'

/**
 * 「清理其它账号本地缓存」的名字判断与 I/O 兜底。
 *
 * 关键不变量：
 *   1. 当前账号的库（含它的视图库）永远不进清理名单 —— 清错就是当前账号的离线数据全丢；
 *   2. PouchDB 的 `_pouch_` 前缀与 `-mrview-<md5>` 视图库后缀都要认出来：
 *      只删主库会留下视图库（那是独立的一个 IndexedDB 库）；
 *   3. 历史遗留库、条目/feed 之类非时间线库不归这里管（有各自的迁移清理）；
 *   4. 浏览器不给枚举（没有 indexedDB.databases()）时说「不支持」，而不是假装「没有缓存」。
 */

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

function setIndexedDb(value: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', {
    value,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb)
  else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'indexedDB')
})

const VIEW_SUFFIX = '-mrview-0123456789abcdef0123456789abcdef'

describe('timelineDbAccount', () => {
  it('从逻辑库名解析账号', () => {
    expect(timelineDbAccount('rssfed-timeline-user-a')).toBe('user-a')
  })

  it('认 PouchDB 的 _pouch_ 前缀（IndexedDB 里的实际库名）', () => {
    expect(timelineDbAccount('_pouch_rssfed-timeline-user-a')).toBe('user-a')
  })

  it('认 map view 库：视图库属于同一个账号', () => {
    expect(timelineDbAccount(`_pouch_rssfed-timeline-user-a${VIEW_SUFFIX}`)).toBe('user-a')
  })

  it('guest 也是一个账号段（未登录时的库）', () => {
    expect(timelineDbAccount('_pouch_rssfed-timeline-guest')).toBe('guest')
  })

  it('不是时间线库（含历史遗留库）时返回 null', () => {
    expect(timelineDbAccount('_pouch_rssfed-entries-user-a')).toBeNull()
    expect(timelineDbAccount('rssfed-user-state-user-a')).toBeNull()
    expect(timelineDbAccount('rssfed-timeline-')).toBeNull()
    expect(timelineDbAccount('_pouch_rssfed-timeline-')).toBeNull()
  })
})

describe('isOtherAccountTimelineDb', () => {
  it('别的账号的库（含视图库）：可清理', () => {
    expect(isOtherAccountTimelineDb('_pouch_rssfed-timeline-user-b', 'user-a')).toBe(true)
    expect(isOtherAccountTimelineDb(`_pouch_rssfed-timeline-user-b${VIEW_SUFFIX}`, 'user-a')).toBe(true)
  })

  it('当前账号的库（含视图库）：不可清理', () => {
    expect(isOtherAccountTimelineDb('_pouch_rssfed-timeline-user-a', 'user-a')).toBe(false)
    expect(isOtherAccountTimelineDb(`_pouch_rssfed-timeline-user-a${VIEW_SUFFIX}`, 'user-a')).toBe(false)
  })

  it('未登录（当前账号是 guest）时，guest 库不可清、其它账号可清', () => {
    expect(isOtherAccountTimelineDb('_pouch_rssfed-timeline-guest', null)).toBe(false)
    expect(isOtherAccountTimelineDb('_pouch_rssfed-timeline-user-a', null)).toBe(true)
  })

  it('非时间线库一律不归这里管', () => {
    expect(isOtherAccountTimelineDb('_pouch_rssfed-feed-user-b', 'user-a')).toBe(false)
  })
})

describe('pickOtherAccountTimelineDbs', () => {
  it('只挑其它账号的主库与视图库，去重且排序稳定', () => {
    const all = [
      '_pouch_rssfed-timeline-user-a',
      `_pouch_rssfed-timeline-user-a${VIEW_SUFFIX}`,
      '_pouch_rssfed-timeline-guest',
      `_pouch_rssfed-timeline-guest${VIEW_SUFFIX}`,
      '_pouch_rssfed-entries-user-a',
      '_pouch_rssfed-user-state-user-a',
      'rssfed-timeline-user-b',
      'rssfed-timeline-user-b'
    ]
    expect(pickOtherAccountTimelineDbs(all, 'user-a')).toEqual([
      '_pouch_rssfed-timeline-guest',
      `_pouch_rssfed-timeline-guest${VIEW_SUFFIX}`,
      'rssfed-timeline-user-b'
    ])
  })

  it('没有其它账号的库时返回空数组', () => {
    expect(pickOtherAccountTimelineDbs(['_pouch_rssfed-timeline-user-a'], 'user-a')).toEqual([])
  })
})

describe('countAccountsOfDbs', () => {
  it('主库与视图库算同一个账号', () => {
    expect(countAccountsOfDbs([
      '_pouch_rssfed-timeline-user-b',
      `_pouch_rssfed-timeline-user-b${VIEW_SUFFIX}`,
      '_pouch_rssfed-timeline-guest'
    ])).toBe(2)
  })

  it('空列表 / 非时间线库：0 个账号', () => {
    expect(countAccountsOfDbs([])).toBe(0)
    expect(countAccountsOfDbs(['_pouch_rssfed-entries-x'])).toBe(0)
  })
})

describe('listActualDbNames', () => {
  it('浏览器不支持 indexedDB.databases() 时返回 null（入口应隐藏）', async () => {
    setIndexedDb({})
    expect(await listActualDbNames()).toBeNull()
    setIndexedDb(undefined)
    expect(await listActualDbNames()).toBeNull()
  })

  it('正常枚举时返回实际库名（过滤无名/空名）', async () => {
    setIndexedDb({
      databases: async () => [
        { name: '_pouch_rssfed-timeline-user-a' },
        { name: '_pouch_rssfed-timeline-user-b' },
        {},
        { name: '' }
      ]
    })
    expect(await listActualDbNames()).toEqual([
      '_pouch_rssfed-timeline-user-a',
      '_pouch_rssfed-timeline-user-b'
    ])
  })

  it('枚举抛错（隐私模式等）时降级为 null，不冒错', async () => {
    setIndexedDb({
      databases: async () => {
        throw new Error('denied')
      }
    })
    expect(await listActualDbNames()).toBeNull()
  })
})

describe('deleteLocalDbs', () => {
  /** 造一个「删除请求」：下一拍按 outcome 回调，outcome 为 'hang' 时不回调 */
  function fakeIdb(outcome: 'success' | 'error' | 'blocked' | 'hang') {
    return {
      deleteDatabase: () => {
        const request: Record<string, (() => void) | undefined> = {}
        if (outcome !== 'hang') {
          queueMicrotask(() => request[`on${outcome}`]?.())
        }
        return request
      }
    }
  }

  it('全部成功：deleted 计数', async () => {
    setIndexedDb(fakeIdb('success'))
    expect(await deleteLocalDbs(['a', 'b'], 50)).toEqual({ deleted: 2, failed: 0 })
  })

  it('被其它标签页占用（onblocked）：算失败，其余照删', async () => {
    setIndexedDb(fakeIdb('blocked'))
    expect(await deleteLocalDbs(['a', 'b'], 50)).toEqual({ deleted: 0, failed: 2 })
  })

  it('删不动时超时收尾，不把整轮清理挂住', async () => {
    setIndexedDb(fakeIdb('hang'))
    expect(await deleteLocalDbs(['a'], 10)).toEqual({ deleted: 0, failed: 1 })
  })

  it('没有 indexedDB：全部算失败（不抛错）', async () => {
    setIndexedDb(undefined)
    expect(await deleteLocalDbs(['a'], 10)).toEqual({ deleted: 0, failed: 1 })
  })
})
