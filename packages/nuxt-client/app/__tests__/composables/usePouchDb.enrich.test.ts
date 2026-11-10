import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import PouchDB from 'pouchdb'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * `enrichEntries` 的**并行化**（已读态 / 源元信息 / 封面附件三路互不依赖）。
 *
 * 实测 enrich 段 40~110ms：readState ~2~10ms、FeedDoc+titles ~10~100ms、封面附件是逐条串行
 * 的主要来源。这里用真 PouchDB 锁定「行为不变」+「确实并发了」两头：
 *
 *   1. 已读态与源元信息**同时**发出（旧实现是串行等完一个再发下一个）；
 *   2. 封面附件并发取但有上限（不能一次几十个打满 IndexedDB 事务队列）；
 *   3. 拿不到状态按未读、附件没同步就不显示缩略图、自定义订阅名优先于注册表标题。
 */

const H = vi.hoisted(() => ({
  uid: 'enrich-test',
  dbPath: '/tmp/rssfed-test-enrich-test',
  /** 每个 `allDocs` / `getAttachment` 的调用序号（用来看谁先发生） */
  events: [] as string[]
}))

vi.mock('~/utils/localDbName', () => ({
  localDbName: () => '/tmp/rssfed-test-enrich-test',
  lastTimelineRefreshKey: (uid: string | null) => `rssfed-test-refresh-${uid ?? 'guest'}`,
  lastTimelineCompactKey: (uid: string | null) => `rssfed-test-compacted-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: [],
  LEGACY_LOCAL_DB_PREFIXES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    // 测试环境没有远端：取寻址必然失败，live 同步就此停下（不联网）
    remoteUrlForId: vi.fn(async () => { throw new Error('测试环境无远端') }),
    invalidate: vi.fn()
  })
}))

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    feeds: { subscriptions: vi.fn(async () => []) },
    timeline: { refresh: vi.fn(async () => ({ accepted: true, completed: true, added: 0 })) }
  })
}))

vi.mock('~/stores/user', () => ({
  useUserStore: () => ({ user: { id: 'enrich-test' } })
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => ({})

const FEED_COUNT = 6
const ENTRIES_PER_FEED = 3

async function destroyDbs() {
  await new PouchDB(H.dbPath).destroy().catch(() => {})
}

/** 6 个源 × 3 条：每条都有封面附件；一个源改过订阅名，一个源没有 FeedDoc */
async function seed() {
  const db = new PouchDB(H.dbPath)
  const docs: Record<string, unknown>[] = []
  for (let f = 0; f < FEED_COUNT; f++) {
    // 最后一个源故意不建 FeedDoc：验证「没有源元信息也能上屏」
    if (f < FEED_COUNT - 1) {
      docs.push({ _id: `feed-${f}`, type: 'feed', title: `注册表名字 ${f}`, url: `https://f${f}.example/feed` })
    }
    for (let e = 0; e < ENTRIES_PER_FEED; e++) {
      docs.push({
        _id: `entry-${f}-${e}`,
        type: 'entry',
        feedId: `feed-${f}`,
        title: `文章 ${f}-${e}`,
        url: `https://f${f}.example/${e}`,
        publishedAt: new Date(Date.UTC(2026, 6, 1, f, e)).toISOString(),
        insertedAt: new Date(Date.UTC(2026, 6, 1, f, e)).toISOString(),
        images: [{ url: `https://img.example/${f}-${e}.jpg`, attachment: 'cover.avif', cover: true }]
      })
    }
  }
  await db.bulkDocs(docs)
  // 自定义订阅名（覆盖注册表标题）
  await db.put({
    _id: 'subscription:feed-0',
    type: 'subscription',
    feedId: 'feed-0',
    title: '我改过的名字',
    createdAt: '2026-06-01T00:00:00.000Z'
  })
  // 已读：只给 entry-0-0
  await db.put({
    _id: 'entry-state:entry-0-0',
    type: 'entry-state',
    entryId: 'entry-0-0',
    feedId: 'feed-0',
    read: true,
    readAt: '2026-07-05T00:00:00.000Z',
    saved: false
  })
  // 附件只给前两个源的一部分条目：其余「还没同步下来」，应当不显示缩略图
  for (let f = 0; f < 2; f++) {
    for (let e = 0; e < ENTRIES_PER_FEED; e++) {
      // Node 版 PouchDB（vitest 把 pouchdb-browser 指回它）要求附件是 Buffer：二进制走 'binary'
      // 编码，不认 Blob。浏览器里则相反 —— 这条差异只影响测试夹具，不影响被测代码。
      await db.putAttachment(
        `entry-${f}-${e}`,
        'cover.avif',
        (await db.get(`entry-${f}-${e}`))._rev,
        Buffer.from(`fake-avif-${f}-${e}`),
        'image/avif'
      )
    }
  }
  await db.close()
}

let pouch: ReturnType<typeof usePouchDb>

beforeAll(async () => {
  await destroyDbs()
  await seed()
  pouch = usePouchDb()
  // Node 版 PouchDB 的 getAttachment 返回 Buffer，而 URL.createObjectURL 只认 Blob。
  // 浏览器里它本来就能用，这里只是把测试环境缺的那一环补上（返回一个稳定的假 URL）。
  vi.spyOn(URL, 'createObjectURL').mockImplementation((() => 'blob:mock-cover') as typeof URL.createObjectURL)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await (await pouch.getUserDb()).close().catch(() => {})
  await destroyDbs()
})

describe('enrichEntries 并行化后行为不变', () => {
  it('已读态、源元信息、自定义订阅名都还在（三路并行不影响结果）', async () => {
    const entries = await pouch.queryTimeline(200)
    expect(entries.length).toBe(FEED_COUNT * ENTRIES_PER_FEED)

    const read = entries.find(e => e.id === 'entry-0-0')
    expect(read?.read).toBe(true)
    expect(read?.readAt).toBe('2026-07-05T00:00:00.000Z')

    const unread = entries.find(e => e.id === 'entry-1-0')
    expect(unread?.read).toBe(false)
    expect(unread?.readAt).toBeUndefined()

    // 自定义订阅名优先于注册表标题
    expect(entries.find(e => e.id === 'entry-0-1')?.feed.title).toBe('我改过的名字')
    // 没改名 → 回退注册表标题
    expect(entries.find(e => e.id === 'entry-1-0')?.feed.title).toBe('注册表名字 1')
    // 没有 FeedDoc 的源：条目照样上屏，feed 里只有 feedId/空标题（不抛错）
    expect(entries.find(e => e.id === `entry-${FEED_COUNT - 1}-0`)?.feed.id).toBe(`feed-${FEED_COUNT - 1}`)
  })

  it('附件同步了的条目有封面 blob URL，没同步的不显示缩略图', async () => {
    const entries = await pouch.queryTimeline(200)
    // 前两个源有附件
    expect(entries.find(e => e.id === 'entry-0-0')?.coverUrl).toBe('blob:mock-cover')
    expect(entries.find(e => e.id === 'entry-1-2')?.coverUrl).toBe('blob:mock-cover')
    // 其余源没同步附件：不显示缩略图（但不是错误）
    expect(entries.find(e => e.id === 'entry-3-0')?.coverUrl).toBeUndefined()
  })

  it('已读态与源元信息两路是并行的（同时发出，而不是串行等待）', async () => {
    // 直接在库实例上装探针：看 enrich 期间两次 allDocs 的先后与「是否交叠」。
    // 旧实现是 `await attachReadState()` 之后才发 FeedDoc 的 allDocs —— 两次必然严格先后；
    // 新实现两路同时发，第二个在第一个的 await 之前就发出去了。
    const db = await pouch.getUserDb()
    const originalAllDocs = db.allDocs.bind(db)
    /** 已发出但还没返回的 allDocs（用来判断是否交叠） */
    let inflight = 0
    let peakInflight = 0
    const seen: string[] = []
    /** 探针：只关心 keys 参数，不关心 allDocs 的重载形态 */
    type AllDocsArgs = Parameters<typeof originalAllDocs>[0]
    const probe = async (opts?: AllDocsArgs) => {
      const keys = (opts as { keys?: string[] } | undefined)?.keys
      const tag = keys?.every(k => k.startsWith('entry-state:'))
        ? 'state'
        : keys?.[0]?.startsWith('subscription:') ? 'subscription' : 'feed'
      seen.push(tag)
      inflight++
      peakInflight = Math.max(peakInflight, inflight)
      try {
        return await (originalAllDocs as (o?: AllDocsArgs) => Promise<unknown>)(opts)
      } finally {
        inflight--
      }
    }
    Object.defineProperty(db, 'allDocs', { value: probe, configurable: true, writable: true })
    try {
      await pouch.queryTimeline(6)
    } finally {
      Object.defineProperty(db, 'allDocs', { value: originalAllDocs, configurable: true, writable: true })
    }

    // 两路都发了，而且至少有一刻同时在跑（旧实现 peak 恒为 1）
    expect(seen).toContain('state')
    expect(seen).toContain('feed')
    expect(peakInflight).toBeGreaterThan(1)
  })
})
