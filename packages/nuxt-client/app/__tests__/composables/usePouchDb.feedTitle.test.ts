import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import PouchDB from 'pouchdb'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 条目上的「源名」必须与侧边栏一致：侧边栏显示的是用户状态库里
 * `subscription:{feedId}` 文档的 title（用户在订阅列表改过的名字），
 * 而集中库的 FeedDoc.title 是抓取时的原始源标题。
 *
 * 这里用真实 PouchDB（固定 /tmp 路径）跑查询链路，保障三条不变量：
 *   1. 有自定义订阅名 → 覆盖注册表标题；
 *   2. 没订阅/没改名 → 回退注册表标题；
 *   3. 改名后立即生效（不引入会读到旧名的缓存）。
 */

// 库名固定到 /tmp，避免污染工作区；同样是为了能精确控制收尾清理
const H = vi.hoisted(() => {
  const uid = 'feedtitle-test'
  return {
    uid,
    entriesPath: `/tmp/rssfed-test-entries-${uid}`,
    statePath: `/tmp/rssfed-test-user-state-${uid}`
  }
})

vi.mock('~/utils/localDbName', () => ({
  localDbName: (kind: string, uid: string | null) => `/tmp/rssfed-test-${kind}-${uid ?? 'guest'}`,
  syncedFeedsKey: (uid: string | null) => `rssfed-test-synced-${uid ?? 'guest'}`,
  LEGACY_LOCAL_DB_NAMES: []
}))

vi.mock('~/composables/useCouchTargets', () => ({
  USER_STATE_ID: '__user_state__',
  useCouchTargets: () => ({
    // 测试环境没有远端：取寻址信息必然失败，用户状态库的 live 同步就此停下（不联网）
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

// Nuxt auto-import：usePouchDb 借 nuxtApp 单例化共享状态（内部会往这个对象上挂 $pouchDbState）
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useNuxtApp = () => ({})

async function destroyDbs() {
  for (const path of [H.entriesPath, H.statePath]) {
    await new PouchDB(path).destroy().catch(() => {})
  }
}

/** 造数据：一个改过名的源、一个没订阅文档的源，各带一条条目 */
async function seed() {
  const entries = new PouchDB(H.entriesPath)
  await entries.bulkDocs([
    { _id: 'feed-custom', type: 'feed', title: '注册表抓来的名字', url: 'https://a.example/feed' },
    { _id: 'feed-plain', type: 'feed', title: '注册表原始标题', url: 'https://b.example/feed' },
    {
      _id: 'entry-custom',
      type: 'entry',
      feedId: 'feed-custom',
      title: '文章一',
      url: 'https://a.example/1',
      publishedAt: '2026-07-01T00:00:00.000Z',
      insertedAt: '2026-07-01T00:00:00.000Z'
    },
    {
      _id: 'entry-plain',
      type: 'entry',
      feedId: 'feed-plain',
      title: '文章二',
      url: 'https://b.example/1',
      publishedAt: '2026-07-02T00:00:00.000Z',
      insertedAt: '2026-07-02T00:00:00.000Z'
    }
  ])
  await entries.close()

  const state = new PouchDB(H.statePath)
  await state.put({
    _id: 'subscription:feed-custom',
    type: 'subscription',
    feedId: 'feed-custom',
    title: '我在订阅列表里改的名字',
    createdAt: '2026-06-01T00:00:00.000Z'
  })
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

describe('条目源名（与侧边栏一致）', () => {
  it('有自定义订阅名 → 覆盖注册表标题', async () => {
    const [entry] = await pouch.queryFeedEntries('feed-custom')
    expect(entry?.feed.title).toBe('我在订阅列表里改的名字')
  })

  it('没有订阅文档的源 → 回退注册表标题', async () => {
    const [entry] = await pouch.queryFeedEntries('feed-plain')
    expect(entry?.feed.title).toBe('注册表原始标题')
  })

  it('改名后立即生效（查询不缓存旧名）', async () => {
    await pouch.updateSubscription('feed-custom', { title: '又改了一次' })
    const [entry] = await pouch.queryFeedEntries('feed-custom')
    expect(entry?.feed.title).toBe('又改了一次')
    // 单源页顶栏走的是同一个读取入口
    expect(await pouch.getSubscriptionTitle('feed-custom')).toBe('又改了一次')
  })

  it('没有订阅文档的源 → getSubscriptionTitle 返回 null（页面回退注册表标题）', async () => {
    expect(await pouch.getSubscriptionTitle('feed-plain')).toBeNull()
  })
})
