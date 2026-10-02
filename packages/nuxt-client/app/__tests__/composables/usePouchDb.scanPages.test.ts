import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import PouchDB from 'pouchdb'
import { usePouchDb } from '~/composables/usePouchDb'
import type { ScanCursor } from '~/composables/usePouchDb'

/**
 * 「只看未读」的扫描层：游标分页 + 只合已读态、**不做 enrich**。
 *
 * 与 readState 测试同一套真实 PouchDB harness（固定 /tmp 路径，跑完即毁）。
 * 这里要盯住的性质：
 *   1. 分页不重不漏（游标含端点，靠多要一行抵消重复）；
 *   2. 扫到的行**没有**源元信息与封面 blob（证明没走 enrich —— 深扫几千条也不会去读附件）；
 *   3. 已读态合进来了（否则挑不出未读）；
 *   4. 单源桶不外溢、分组按时间归并且游标按源分别记；
 *   5. 扫描不受列表快照约束：从最新一条往下扫，同步刚写进来的条目也在范围内。
 */

const H = vi.hoisted(() => ({
  uid: 'scanpages-test',
  entriesPath: '/tmp/rssfed-test-entries-scanpages-test',
  statePath: '/tmp/rssfed-test-user-state-scanpages-test'
}))

vi.mock('~/utils/localDbName', () => ({
  localDbName: (kind: string, uid: string | null) => `/tmp/rssfed-test-${kind}-${uid ?? 'guest'}`,
  syncedFeedsKey: (uid: string | null) => `rssfed-test-synced-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  USER_STATE_ID: '__user_state__',
  useCouchTargets: () => ({
    remoteUrlForId: vi.fn(async () => { throw new Error('测试环境无远端') }),
    invalidate: vi.fn()
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({ feeds: { subscriptions: vi.fn(async () => []) } })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: H.uid } })
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => ({})

/** 时间基准：越往前越旧（hoursAgo 越大越旧） */
const BASE = Date.UTC(2026, 0, 1)
const at = (hoursAgo: number) => new Date(BASE - hoursAgo * 3600_000).toISOString()

// feed-a 与 feed-b 交错发布：合并后的期望顺序一眼可验证
const FEED_A: Array<[string, number]> = [['e0', 0], ['e1', 2], ['e2', 4], ['e3', 6], ['e4', 8]]
const FEED_B: Array<[string, number]> = [['b0', 1], ['b1', 3], ['b2', 5]]
/** 合并（desc）后的完整顺序 */
const MERGED = ['e0', 'b0', 'e1', 'b1', 'e2', 'b2', 'e3', 'e4']

function entryDoc(id: string, feedId: string, hoursAgo: number) {
  return {
    _id: id,
    type: 'entry',
    feedId,
    title: `标题 ${id}`,
    url: `https://${feedId}.example/${id}`,
    publishedAt: at(hoursAgo),
    insertedAt: at(hoursAgo)
  }
}

async function destroyDbs() {
  for (const path of [H.entriesPath, H.statePath]) {
    await new PouchDB(path).destroy().catch(() => {})
  }
}

async function seed() {
  const entries = new PouchDB(H.entriesPath)
  await entries.bulkDocs([
    { _id: 'feed-a', type: 'feed', title: '源 A', url: 'https://a.example/feed', siteUrl: 'https://a.example' },
    { _id: 'feed-b', type: 'feed', title: '源 B', url: 'https://b.example/feed' },
    ...FEED_A.map(([id, hoursAgo]) => entryDoc(id, 'feed-a', hoursAgo)),
    ...FEED_B.map(([id, hoursAgo]) => entryDoc(id, 'feed-b', hoursAgo)),
    // e0 带封面附件：扫描如果偷偷 enrich 了，就会去读这个附件
    {
      ...entryDoc('e0', 'feed-a', 0),
      images: [{ url: 'https://a.example/cover.png', attachment: 'img-0.avif', cover: true }],
      _attachments: {
        'img-0.avif': { content_type: 'image/avif', data: Buffer.from('fake-avif').toString('base64') }
      }
    }
  ])
  await entries.close()

  const state = new PouchDB(H.statePath)
  await state.bulkDocs([
    { _id: 'entry-state:e1', type: 'entry-state', entryId: 'e1', feedId: 'feed-a', read: true, readAt: at(0), saved: false },
    { _id: 'entry-state:b1', type: 'entry-state', entryId: 'b1', feedId: 'feed-b', read: true, readAt: at(0), saved: false }
  ])
  await state.close()
}

let pouch: ReturnType<typeof usePouchDb>

beforeAll(async () => {
  await destroyDbs()
  await seed()
  pouch = usePouchDb()
})

afterAll(async () => {
  await pouch.getUserStateDb().close().catch(() => {})
  await destroyDbs()
})

describe('scanTimelinePage：时间线游标分页', () => {
  it('一路扫到底：不重不漏、最后一批标记 exhausted', async () => {
    const ids: string[] = []
    let cursor: ScanCursor | null = null
    let rounds = 0
    for (;;) {
      const page = await pouch.scanTimelinePage(cursor, 3)
      ids.push(...page.rows.map(row => row.id))
      cursor = page.cursor
      rounds++
      if (page.exhausted || rounds > 10) break
    }

    expect(ids).toEqual(MERGED)
    expect(rounds).toBe(3) // 3 + 3 + 2
  })

  it('合上已读态（否则挑不出未读）', async () => {
    const page = await pouch.scanTimelinePage(null, 8)

    expect(page.rows.find(row => row.id === 'e1')?.read).toBe(true)
    expect(page.rows.find(row => row.id === 'b1')?.read).toBe(true)
    expect(page.rows.find(row => row.id === 'e0')?.read).toBe(false)
  })
})

describe('扫描不做 enrich', () => {
  it('扫到的行没有源名、没有封面 blob；对照的列表查询两者都有', async () => {
    const page = await pouch.scanFeedPage('feed-a', null, 5)
    const scanned = page.rows[0]!

    expect(scanned.id).toBe('e0')
    // docToEntry 的占位值：enrich 才会把 FeedDoc 的源名填进来
    expect(scanned.feed.title).toBe('')
    expect(scanned.feed.feedUrl).toBe('')
    // 封面要 getAttachment + createObjectURL，扫描这条路一次都不该走
    expect(scanned.coverUrl).toBeUndefined()

    const enriched = await pouch.queryFeedEntries('feed-a', 5)
    expect(enriched[0]!.feed.title).toBe('源 A')
    expect(enriched[0]!.feed.siteUrl).toBe('https://a.example')
  })
})

describe('scanFeedPage：单源桶隔离', () => {
  it('只在桶内翻页，游标续扫接得上', async () => {
    const first = await pouch.scanFeedPage('feed-b', null, 2)
    expect(first.rows.map(row => row.id)).toEqual(['b0', 'b1'])
    expect(first.exhausted).toBe(false)

    const second = await pouch.scanFeedPage('feed-b', first.cursor, 2)
    expect(second.rows.map(row => row.id)).toEqual(['b2'])
    expect(second.exhausted).toBe(true)
  })

  it('首轮从最新一条开始扫（不受列表快照约束）：桶内最新的 e0 也在结果里', async () => {
    const page = await pouch.scanFeedPage('feed-a', null, 10)

    expect(page.rows.map(row => row.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
  })
})

describe('scanGroupPage：多源归并', () => {
  it('按时间归并、游标按源分别记，分页不重不漏', async () => {
    const first = await pouch.scanGroupPage(['feed-a', 'feed-b'], null, 3)
    expect(first.rows.map(row => row.id)).toEqual(['e0', 'b0', 'e1'])
    expect(first.exhausted).toBe(false)

    const second = await pouch.scanGroupPage(['feed-a', 'feed-b'], first.cursor, 3)
    expect(second.rows.map(row => row.id)).toEqual(['b1', 'e2', 'b2'])
    expect(second.rows.find(row => row.id === 'b1')?.read).toBe(true)

    const third = await pouch.scanGroupPage(['feed-a', 'feed-b'], second.cursor, 3)
    expect(third.rows.map(row => row.id)).toEqual(['e3', 'e4'])
    expect(third.exhausted).toBe(true)
  })

  it('空分组直接算扫到底', async () => {
    const page = await pouch.scanGroupPage([], null, 5)

    expect(page.rows).toEqual([])
    expect(page.exhausted).toBe(true)
  })
})
