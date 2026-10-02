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

/** 直接读一条状态文档（断言字段级行为用） */
async function stateDoc(entryId: string) {
  return await pouch.getUserStateDb().get(`entry-state:${entryId}`) as unknown as {
    read?: boolean
    readAt?: string
    saved?: boolean
    savedAt?: string
    feedId?: string
  }
}

/** 把某条状态文档标成「已收藏 + 指定收藏时间」，用于给收藏列表造序 */
async function setSavedAt(entryId: string, savedAt: string) {
  const db = pouch.getUserStateDb()
  const existing = await db.get(`entry-state:${entryId}`) as unknown as Record<string, unknown>
  await db.put({ ...existing, saved: true, savedAt })
}

describe('单条标记：markRead / toggleSaved', () => {
  it('markRead 新建状态文档：只碰 read，收藏位给默认 false', async () => {
    await pouch.markRead('entry-c', 'feed-a', true)

    const doc = await stateDoc('entry-c')
    expect(doc.read).toBe(true)
    expect(doc.feedId).toBe('feed-a')
    expect(doc.saved).toBe(false)
    expect(doc.readAt).toBeTruthy()
  })

  it('markRead 改回未读时清掉 readAt，且不动收藏位', async () => {
    // entry-c 已是已读，先收藏它，再标回未读
    expect(await pouch.toggleSaved('entry-c', 'feed-a')).toBe(true)
    await pouch.markRead('entry-c', 'feed-a', false)

    const doc = await stateDoc('entry-c')
    expect(doc.read).toBe(false)
    expect(doc.readAt).toBeUndefined()
    expect(doc.saved).toBe(true)
  })

  it('toggleSaved 往返切换并返回切换后的值，未读位保持不变', async () => {
    expect(await pouch.toggleSaved('entry-d', 'feed-a')).toBe(true)
    let doc = await stateDoc('entry-d')
    expect(doc.saved).toBe(true)
    expect(doc.savedAt).toBeTruthy()
    expect(doc.read).toBe(false) // 新建时 read 默认 false，不被收藏动作带成已读

    expect(await pouch.toggleSaved('entry-d', 'feed-a')).toBe(false)
    doc = await stateDoc('entry-d')
    expect(doc.saved).toBe(false)
    expect(doc.savedAt).toBeUndefined()
  })
})

describe('querySavedEntries 收藏列表', () => {
  it('按收藏时间倒序只返回本地已有的条目', async () => {
    await setSavedAt('entry-a', '2026-07-01T00:00:00.000Z')
    await setSavedAt('entry-b', '2026-07-03T00:00:00.000Z')
    // 收藏了一条本地根本没有的条目（别的设备收藏、条目还没同步过来）
    await pouch.getUserStateDb().put({
      _id: 'entry-state:entry-missing',
      type: 'entry-state',
      entryId: 'entry-missing',
      feedId: 'feed-a',
      read: false,
      saved: true,
      savedAt: '2026-07-04T00:00:00.000Z'
    })

    const list = await pouch.querySavedEntries()
    expect(list.map(e => e.id)).toEqual(['entry-b', 'entry-a'])
    expect(list.every(e => e.starred)).toBe(true)
  })

  it('窗口按「本地存在的条目」计数：查不到的 id 不占名额', async () => {
    // entry-missing 最新，但它不在本地；limit=1 仍应给出下一条真实存在的收藏
    const list = await pouch.querySavedEntries(1)
    expect(list.map(e => e.id)).toEqual(['entry-b'])
  })

  it('没有收藏时返回空数组', async () => {
    const db = pouch.getUserStateDb()
    for (const id of ['entry-a', 'entry-b']) {
      const doc = await db.get(`entry-state:${id}`) as unknown as Record<string, unknown>
      await db.put({ ...doc, saved: false })
    }
    expect(await pouch.querySavedEntries()).toEqual([])
  })
})
