import { describe, it, expect, afterEach } from 'vitest'
import { useLocalDbCleanup } from '~/composables/useLocalDbCleanup'

/**
 * 设置页「其它账号的本地缓存」的状态层。
 *
 * 只验证三件事：扫出来的名单对不对（当前账号的库永远不在里面）、清完之后是否**重新扫**
 * （没删掉的库要如实留着）、以及浏览器不支持枚举时入口隐藏。删除细节由
 * utils/localDbCleanup 的单测覆盖。
 */

const VIEW_SUFFIX = '-mrview-0123456789abcdef0123456789abcdef'
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb)
  else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'indexedDB')
})

/**
 * 假 IndexedDB：从 names 里枚举，删除会真的把名字移出列表。
 * outcome 用来模拟「被别的标签页占着」（blocked）。
 */
function fakeIndexedDb(names: string[], outcome: 'success' | 'blocked' | 'error' = 'success') {
  return {
    databases: async () => names.map(name => ({ name })),
    deleteDatabase: (name: string) => {
      const request: Record<string, (() => void) | undefined> = {}
      queueMicrotask(() => {
        if (outcome === 'success') {
          const index = names.indexOf(name)
          if (index >= 0) names.splice(index, 1)
        }
        request[`on${outcome}`]?.()
      })
      return request
    }
  }
}

function setIndexedDb(value: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', {
    value,
    configurable: true,
    writable: true
  })
}

describe('useLocalDbCleanup', () => {
  it('浏览器不支持枚举：supported 为 false，入口应隐藏', async () => {
    setIndexedDb(undefined)
    const cleanup = useLocalDbCleanup()
    await cleanup.scan('user-a')
    expect(cleanup.supported.value).toBe(false)
    expect(cleanup.canClean.value).toBe(false)
  })

  it('只扫出其它账号的库（主库 + 视图库），当前账号与历史遗留库不碰', async () => {
    setIndexedDb(fakeIndexedDb([
      '_pouch_rssfed-timeline-user-a',
      `_pouch_rssfed-timeline-user-a${VIEW_SUFFIX}`,
      '_pouch_rssfed-timeline-guest',
      `_pouch_rssfed-timeline-guest${VIEW_SUFFIX}`,
      '_pouch_rssfed-entries-user-a'
    ]))
    const cleanup = useLocalDbCleanup()
    await cleanup.scan('user-a')

    expect(cleanup.supported.value).toBe(true)
    expect(cleanup.accountCount.value).toBe(1)
    expect(cleanup.canClean.value).toBe(true)
    expect(cleanup.dbNames.value).toEqual([
      '_pouch_rssfed-timeline-guest',
      `_pouch_rssfed-timeline-guest${VIEW_SUFFIX}`
    ])
  })

  it('清理后重新扫描：删干净的名单变空，账号数归零', async () => {
    setIndexedDb(fakeIndexedDb([
      '_pouch_rssfed-timeline-user-a',
      '_pouch_rssfed-timeline-user-b',
      `_pouch_rssfed-timeline-user-b${VIEW_SUFFIX}`
    ]))
    const cleanup = useLocalDbCleanup()
    await cleanup.scan('user-a')
    expect(cleanup.accountCount.value).toBe(1)

    const result = await cleanup.clean('user-a')

    expect(result).toEqual({ deleted: 2, failed: 0, accounts: 1 })
    expect(cleanup.dbNames.value).toEqual([])
    expect(cleanup.accountCount.value).toBe(0)
    expect(cleanup.error.value).toBeNull()
  })

  it('被其它标签页占用时：留下名单并给出原因，而不是假装清空成功', async () => {
    setIndexedDb(fakeIndexedDb(['_pouch_rssfed-timeline-user-b'], 'blocked'))
    const cleanup = useLocalDbCleanup()
    await cleanup.scan('user-a')

    const result = await cleanup.clean('user-a')

    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(1)
    expect(cleanup.dbNames.value).toEqual(['_pouch_rssfed-timeline-user-b'])
    expect(cleanup.error.value).toContain('其它标签页')
  })

  it('会话还没就绪（userId 为 null）时拒绝清理：分不清哪个是当前账号的库', async () => {
    setIndexedDb(fakeIndexedDb(['_pouch_rssfed-timeline-someone']))
    const cleanup = useLocalDbCleanup()
    await cleanup.scan(null)

    expect(await cleanup.clean(null)).toEqual({ deleted: 0, failed: 0, accounts: 0 })
    expect(cleanup.dbNames.value).toEqual(['_pouch_rssfed-timeline-someone'])
  })

  it('没有可清理的库时：canClean 为 false', async () => {
    setIndexedDb(fakeIndexedDb(['_pouch_rssfed-timeline-user-a']))
    const cleanup = useLocalDbCleanup()
    await cleanup.scan('user-a')
    expect(cleanup.supported.value).toBe(true)
    expect(cleanup.canClean.value).toBe(false)
    expect(cleanup.accountCount.value).toBe(0)
  })
})
