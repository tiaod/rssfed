import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import PouchDB from 'pouchdb'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 已读状态：列表查询要把本地 `entry-state` 合进条目，批量标记要能一次写完、
 * 且不重复写已经是对应状态的条目。
 *
 * 与 feedTitle 测试同一套真实 PouchDB harness（固定 /tmp 路径，跑完即毁）：
 * 已读态跨两个库（条目在集中库、状态在用户状态库），只有真跑一遍才验证得了合并是否正确。
 */

const H = vi.hoisted(() => ({
  uid: 'readstate-test',
  entriesPath: '/tmp/rssfed-test-entries-readstate-test',
  statePath: '/tmp/rssfed-test-user-state-readstate-test'
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

async function destroyDbs() {
  for (const path of [H.entriesPath, H.statePath]) {
    await new PouchDB(path).destroy().catch(() => {})
  }
}

/** 一个源 + 两条条目；其中 entry-a 已经读过并收藏 */
async function seed() {
  const entries = new PouchDB(H.entriesPath)
  await entries.bulkDocs([
    { _id: 'feed-a', type: 'feed', title: '某源', url: 'https://a.example/feed' },
    {
      _id: 'entry-a',
      type: 'entry',
      feedId: 'feed-a',
      title: '文章一',
      url: 'https://a.example/1',
      publishedAt: '2026-07-02T00:00:00.000Z',
      insertedAt: '2026-07-02T00:00:00.000Z'
    },
    {
      _id: 'entry-b',
      type: 'entry',
      feedId: 'feed-a',
      title: '文章二',
      url: 'https://a.example/2',
      publishedAt: '2026-07-01T00:00:00.000Z',
      insertedAt: '2026-07-01T00:00:00.000Z'
    }
  ])
  await entries.close()

  const state = new PouchDB(H.statePath)
  await state.put({
    _id: 'entry-state:entry-a',
    type: 'entry-state',
    entryId: 'entry-a',
    feedId: 'feed-a',
    read: true,
    readAt: '2026-07-03T00:00:00.000Z',
    saved: true
  })
  await state.close()
}

let pouch: ReturnType<typeof usePouchDb>

async function readOf(entryId: string): Promise<boolean | undefined> {
  const entries = await pouch.queryFeedEntries('feed-a')
  return entries.find(e => e.id === entryId)?.read
}

beforeAll(async () => {
  await destroyDbs()
  await seed()
  pouch = usePouchDb()
})

afterAll(async () => {
  await pouch.getUserStateDb().close().catch(() => {})
  await destroyDbs()
})

describe('列表查询合并已读状态', () => {
  it('有 entry-state 的条目带上 read / starred', async () => {
    const [entryA] = (await pouch.queryFeedEntries('feed-a')).filter(e => e.id === 'entry-a')
    expect(entryA?.read).toBe(true)
    expect(entryA?.starred).toBe(true)
  })

  it('没有 entry-state 的条目保持未读', async () => {
    expect(await readOf('entry-b')).toBe(false)
  })
})

describe('markManyRead 批量标记', () => {
  it('只写需要改的条目，已读的不重复写', async () => {
    // entry-a 已是已读、entry-b 未读 → 只应写 1 条
    const written = await pouch.markManyRead([
      { id: 'entry-a', feedId: 'feed-a' },
      { id: 'entry-b', feedId: 'feed-a' }
    ])
    expect(written).toBe(1)
    expect(await readOf('entry-b')).toBe(true)

    // 再标一次全都已是已读 → 不写
    expect(await pouch.markManyRead([
      { id: 'entry-a', feedId: 'feed-a' },
      { id: 'entry-b', feedId: 'feed-a' }
    ])).toBe(0)
  })

  it('传 read=false 可以批量清掉已读（保留收藏位）', async () => {
    expect(await pouch.markManyRead([{ id: 'entry-a', feedId: 'feed-a' }], false)).toBe(1)
    expect(await readOf('entry-a')).toBe(false)

    const [entryA] = (await pouch.queryFeedEntries('feed-a')).filter(e => e.id === 'entry-a')
    expect(entryA?.starred).toBe(true) // 只动 read，不动 saved
  })

  it('空数组直接返回 0，不碰数据库', async () => {
    expect(await pouch.markManyRead([])).toBe(0)
  })
})
