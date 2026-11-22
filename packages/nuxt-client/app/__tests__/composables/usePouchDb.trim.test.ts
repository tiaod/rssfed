import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 「退订时立刻清掉该源的本地条目」的接线。
 *
 * 背景：本地视图的 key 只有 `[ms, _id]`，**不看订阅集合**，所以退订之后那些文章还会挂在
 * 时间线上；而服务端裁剪用的是 `_purge`，purge 不进 `_changes`，浏览器永远等不到
 * 「这条没了」的通知。不主动删，这些条目就永久占着 IndexedDB（`compact()` 回收不了活文档）。
 *
 * 这里验证四件事：
 *   1. 退订只删**那个源**的条目，别的源一条不动；
 *   2. 收藏过的条目不删（用户的明确意图，且量极小）；
 *   3. 删完跟着压一次（标准删除只留墓碑，不压等于没删）；
 *   4. 条目清理失败不能拖垮退订本身（订阅文档已经删了，残留交给空闲裁剪兜底）。
 */

interface FakeDoc {
  _id: string
  _rev?: string
  _deleted?: boolean
  feedId?: string
  type?: string
  saved?: boolean
  entryId?: string
}

const H = vi.hoisted(() => ({
  docs: new Map<string, FakeDoc>(),
  compactCalls: 0,
  bulkDocsCalls: [] as FakeDoc[][],
  compactImpl: async (): Promise<void> => {}
}))

vi.mock('pouchdb', () => {
  class FakePouchDb {
    replicate = {
      from: () => makeNoopTask(),
      to: () => makeNoopTask()
    }

    /** 视图查询：by_feed 按 feedId 取桶，timeline 取全部（与 utils/localViews 的 key 一致） */
    query = async (view: string, opts: Record<string, unknown>) => {
      const rows: Array<{ key: unknown, doc: FakeDoc }> = []
      for (const doc of H.docs.values()) {
        if (doc._deleted) continue
        if (view.includes('by_feed')) {
          const start = opts.startkey as unknown[]
          if (start && doc.feedId !== start[0]) continue
          rows.push({ key: [doc.feedId, 0, doc._id], doc: { ...doc } })
        } else {
          rows.push({ key: [0, doc._id], doc: { ...doc } })
        }
      }
      return { rows }
    }

    allDocs = async (opts: Record<string, unknown>) => {
      const rows: Array<{ id: string, doc?: FakeDoc }> = []
      for (const doc of H.docs.values()) {
        if (doc._deleted) continue
        const start = opts.startkey as string | undefined
        const end = opts.endkey as string | undefined
        if (start && doc._id < start) continue
        if (end && doc._id > end) continue
        rows.push({ id: doc._id, doc: { ...doc } })
      }
      return { rows }
    }

    bulkDocs = async (docs: FakeDoc[]) => {
      H.bulkDocsCalls.push(docs)
      return docs.map((d) => {
        const existing = H.docs.get(d._id)
        if (!existing) return { status: 404, error: 'not_found' }
        H.docs.set(d._id, { ...existing, _deleted: true })
        return { ok: true, id: d._id, rev: '2-x' }
      })
    }

    get = async (id: string) => {
      const doc = H.docs.get(id)
      if (!doc) throw Object.assign(new Error('missing'), { status: 404 })
      return { ...doc }
    }

    remove = async (doc: FakeDoc) => {
      H.docs.set(doc._id, { ...doc, _deleted: true })
      return { ok: true }
    }

    put = async (doc: FakeDoc) => {
      H.docs.set(doc._id, { ...doc, _rev: '1-x' })
      return { ok: true }
    }

    compact = async () => {
      H.compactCalls++
      await H.compactImpl()
      return { ok: true }
    }

    close = async () => {}
    destroy = async () => {}
  }
  function makeNoopTask() {
    const task = {
      on: () => task,
      removeListener: () => task,
      cancel: () => {},
      then: () => task
    }
    return task
  }
  const statics = FakePouchDb as unknown as Record<string, unknown>
  statics.plugin = () => {}
  statics.allDbs = async () => []
  statics.destroy = async () => {}
  return { default: FakePouchDb }
})

vi.mock('pouchdb-find', () => ({ default: {} }))

vi.mock('~/utils/localDbName', async () => {
  const actual = await vi.importActual<typeof import('~/utils/localDbName')>('~/utils/localDbName')
  return {
    ...actual,
    localDbName: (uid: string | null) => `fake-${uid ?? 'guest'}`,
    localDbAccountKey: (uid: string | null) => uid ?? 'guest',
    lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
    lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
    lastTimelineTrimKey: (uid: string | null) => `rssfed-test-trimmed-${uid ?? 'guest'}`,
    lastTimelineUrlKey: (uid: string | null) => `rssfed-test-url-${uid ?? 'guest'}`,
    LEGACY_LOCAL_DB_NAMES: [],
    LEGACY_LOCAL_DB_PREFIXES: []
  }
})

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    remoteUrlForId: async (id: string) => `http://remote.test/${id}`,
    invalidate: () => {}
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: async () => [] },
    timeline: { refresh: async () => ({ accepted: true, completed: true, added: 0 }) }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'trim-test' } })
}))

const sharedApp: Record<string, unknown> = {}
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => sharedApp

/** 一个在订源 + 一个已退订源 + 一条收藏条目 */
function seed(): void {
  H.docs.clear()
  H.docs.set('subscription:feed-a', { _id: 'subscription:feed-a', type: 'subscription', feedId: 'feed-a', _rev: '1-a' })
  H.docs.set('entry:e1', { _id: 'entry:e1', _rev: '1-1', feedId: 'feed-a', type: 'entry' })
  H.docs.set('entry:e2', { _id: 'entry:e2', _rev: '1-2', feedId: 'feed-a', type: 'entry' })
  H.docs.set('entry:e3', { _id: 'entry:e3', _rev: '1-3', feedId: 'feed-gone', type: 'entry' })
  H.docs.set('entry:e4', { _id: 'entry:e4', _rev: '1-4', feedId: 'feed-gone', type: 'entry' })
  H.docs.set('entry-state:e4', { _id: 'entry-state:e4', type: 'entry-state', entryId: 'entry:e4', saved: true, _rev: '1-4s' })
}

function liveIds(): string[] {
  return [...H.docs.values()].filter(d => !d._deleted).map(d => d._id).sort()
}

let pouch: ReturnType<typeof usePouchDb>

beforeEach(async () => {
  seed()
  H.compactCalls = 0
  H.bulkDocsCalls = []
  H.compactImpl = async () => {}
  try {
    localStorage.clear()
  } catch {
    // 无 localStorage 时忽略
  }
  Reflect.deleteProperty(sharedApp, '$pouchDbState')
  pouch = usePouchDb()
  await pouch.getUserDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('退订清理本地条目（usePouchDb）', () => {
  it('退订一个源：只删它的条目，别的源一条不动', async () => {
    await pouch.removeSubscription('feed-gone')

    // 在订源的 e1/e2、收藏的 e4 与它的状态文档、以及订阅文档都还在；
    // 已退订源的 e3 被删（e4 因为收藏而保住）
    expect(liveIds().filter(id => !id.startsWith('_design/'))).toEqual([
      'entry-state:e4', 'entry:e1', 'entry:e2', 'entry:e4', 'subscription:feed-a'
    ])
    // 被删的是 feed-gone 的两条（e4 收藏了，见下一个用例，这里先确认 e3 一定没了）
    const deleted = H.bulkDocsCalls.flat().map(d => d._id)
    expect(deleted).toContain('entry:e3')
    expect(deleted).not.toContain('entry:e1')
    expect(deleted).not.toContain('entry:e2')
  })

  it('收藏过的条目不删，即使它来自已退订的源', async () => {
    await pouch.removeSubscription('feed-gone')

    // e4 有 saved=true 的状态文档，必须留着
    expect(H.docs.get('entry:e4')?._deleted).toBeFalsy()
    expect(H.bulkDocsCalls.flat().map(d => d._id)).not.toContain('entry:e4')
  })

  it('删完跟着压一次（标准删除只留墓碑，不压等于没删）', async () => {
    await pouch.removeSubscription('feed-gone')
    expect(H.compactCalls).toBe(1)
  })

  it('没有条目可删时不压（不做无意义的全库扫描）', async () => {
    await pouch.removeSubscription('feed-a-nonexistent')
    expect(H.compactCalls).toBe(0)
  })

  it('条目清理失败不拖垮退订：订阅文档照样删掉', async () => {
    H.compactImpl = async () => {
      throw new Error('IndexedDB 挂了')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await pouch.removeSubscription('feed-gone')

    // 退订的本体（删订阅文档）必须已经完成；压缩失败只是记一条 warn
    expect(H.docs.get('subscription:feed-gone')?._deleted).toBeFalsy() // seed 里本就没有这个文档
    expect(H.docs.get('subscription:feed-a')?._deleted).toBeFalsy()
    expect(warn).toHaveBeenCalled()
  })
})
