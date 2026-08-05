import PouchDB from 'pouchdb'
import type { RssEntry } from '~/types/rss'
import type { SubscriptionItem } from '~/composables/useCouchDb'

export interface SyncStatus {
  feedId: string
  status: 'syncing' | 'idle' | 'error'
  /** 同步版本号：每次有数据变化时递增，页面可 watch 后重新查询条目 */
  version: number
  error?: string
}

/**
 * 管理 PouchDB 多库同步，提供跨源条目查询能力。
 *
 * 每个订阅源对应一个 PouchDB 实例，通过 Hono 代理同步 CouchDB。
 * 用户状态库（已读/收藏）也通过 PouchDB 双向同步。
 */
export function usePouchDb() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')

  /** 当前已激活的 PouchDB 实例集合 */
  const dbs = new Map<string, PouchDB.Database>()
  const syncHandles = new Map<string, PouchDB.Replication.Sync<{}>>()
  const syncStatuses = reactive<Record<string, SyncStatus>>({})

  /**
   * 获取或创建某个 feed 的 PouchDB 实例并开始同步
   */
  function syncFeed(feedId: string) {
    if (dbs.has(feedId)) return

    const db = new PouchDB(`rssfed-feed-${feedId}`)
    dbs.set(feedId, db)
    syncStatuses[feedId] = { feedId, status: 'syncing', version: 0 }

    const remoteUrl = `${base}/api/couchdb/proxy/feed/${encodeURIComponent(feedId)}`
    const sync = PouchDB.sync(db, remoteUrl, {
      live: true,
      retry: true,
    })
      .on('change', () => {
        // 每次同步到新数据都递增版本号，触发页面重新查询
        syncStatuses[feedId] = {
          feedId,
          status: 'idle',
          version: (syncStatuses[feedId]?.version ?? 0) + 1,
        }
      })
      .on('error', (err) => {
        syncStatuses[feedId] = {
          feedId,
          status: 'error',
          version: syncStatuses[feedId]?.version ?? 0,
          error: String(err),
        }
      })

    syncHandles.set(feedId, sync)
  }

  /**
   * 停止同步某个 feed
   */
  function unsyncFeed(feedId: string) {
    syncHandles.get(feedId)?.cancel()
    syncHandles.delete(feedId)
    dbs.get(feedId)?.close()
    dbs.delete(feedId)
    delete syncStatuses[feedId]
  }

  /**
   * 从本地 PouchDB 查询条目，按时间倒序
   */
  async function queryEntries(feedIds: string[], limit = 50): Promise<RssEntry[]> {
    const allEntries: RssEntry[] = []

    for (const feedId of feedIds) {
      const db = dbs.get(feedId)
      if (!db) continue

      try {
        const result = await db.allDocs({
          include_docs: true,
          startkey: 'entry:',
          endkey: 'entry:\uffff',
          limit,
        })

        for (const row of result.rows) {
          const doc = row.doc as any
          if (!doc || doc.type !== 'entry') continue
          allEntries.push({
            id: doc._id,
            feedId: doc.feedId,
            title: doc.title ?? '',
            url: doc.url ?? '',
            content: doc.content,
            description: doc.description,
            author: doc.author,
            publishedAt: doc.publishedAt,
            insertedAt: doc.insertedAt,
            categories: doc.categories,
            feed: {
              id: doc.feedId,
              title: '',
              siteUrl: '',
              feedUrl: '',
              lastFetchedAt: '',
            },
            starred: false,
            read: false,
            readingTime: 0,
          })
        }
      } catch {
        // DB may not have synced yet
      }
    }

    // 按 publishedAt 降序排序
    allEntries.sort((a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    )

    return allEntries.slice(0, limit)
  }

  /**
   * 获取单条条目的完整内容
   */
  async function getEntry(entryId: string): Promise<RssEntry | null> {
    for (const [feedId, db] of dbs.entries()) {
      try {
        const doc = await db.get(entryId) as any
        if (doc && doc.type === 'entry') {
          return {
            id: doc._id,
            feedId: doc.feedId,
            title: doc.title ?? '',
            url: doc.url ?? '',
            content: doc.content,
            description: doc.description,
            author: doc.author,
            publishedAt: doc.publishedAt,
            insertedAt: doc.insertedAt,
            categories: doc.categories,
            feed: {
              id: doc.feedId,
              title: '',
              siteUrl: '',
              feedUrl: '',
              lastFetchedAt: '',
            },
            starred: false,
            read: false,
            readingTime: 0,
          }
        }
      } catch {
        // continue searching
      }
    }
    return null
  }

  /**
   * 获取用户状态库 PouchDB 实例（用于已读/收藏标记）
   */
  function getUserStateDb(): PouchDB.Database {
    const key = '__user_state__'
    if (!dbs.has(key)) {
      const db = new PouchDB('rssfed-user-state')
      dbs.set(key, db)

      // 启动双向同步
      const remoteUrl = `${base}/api/couchdb/proxy/user-state`
      PouchDB.sync(db, remoteUrl, {
        live: true,
        retry: true,
      }).on('error', (err) => {
        console.error('User state sync error:', err)
      })

      // 将 handle 存入以便清理
      syncHandles.set(key, {} as any) // placeholder
    }
    return dbs.get(key)!
  }

  /**
   * 标记条目为已读
   */
  async function markRead(entryId: string, feedId: string, read: boolean) {
    const stateDb = getUserStateDb()
    const docId = `entry-state:${entryId}`

    try {
      const existing = await stateDb.get(docId) as any
      await stateDb.put({
        ...existing,
        read,
        readAt: read ? new Date().toISOString() : undefined,
      })
    } catch {
      await stateDb.put({
        _id: docId,
        type: 'entry-state',
        entryId,
        feedId,
        read,
        readAt: read ? new Date().toISOString() : undefined,
        saved: false,
      })
    }
  }

  /**
   * 收藏/取消收藏条目
   */
  async function toggleSaved(entryId: string, feedId: string) {
    const stateDb = getUserStateDb()
    const docId = `entry-state:${entryId}`

    try {
      const existing = await stateDb.get(docId) as any
      await stateDb.put({
        ...existing,
        saved: !existing.saved,
        savedAt: !existing.saved ? new Date().toISOString() : undefined,
      })
    } catch {
      await stateDb.put({
        _id: docId,
        type: 'entry-state',
        entryId,
        feedId,
        read: false,
        saved: true,
        savedAt: new Date().toISOString(),
      })
    }
  }

  /**
   * 清理所有 PouchDB 实例
   */
  function destroyAll() {
    for (const [key, handle] of syncHandles.entries()) {
      handle.cancel?.()
    }
    syncHandles.clear()
    for (const [, db] of dbs.entries()) {
      db.close()
    }
    dbs.clear()
  }

  // ── 订阅管理（离线优先，读写本地 PouchDB，自动同步远端） ──

  /**
   * 获取本地订阅列表（离线可用，从 PouchDB 读取）
   */
  async function listSubscriptions(): Promise<SubscriptionItem[]> {
    const stateDb = getUserStateDb()
    const result = await stateDb.allDocs({
      include_docs: true,
      startkey: 'subscription:',
      endkey: 'subscription:\uffff',
    })
    return result.rows
      .map(r => r.doc as any)
      .filter(doc => doc?.type === 'subscription')
      .map(doc => ({
        id: doc.feedId,
        title: doc.title ?? '',
        siteUrl: doc.siteUrl,
        description: doc.description,
        image: doc.image,
        category: doc.category,
        createdAt: doc.createdAt ?? new Date().toISOString(),
      }))
  }

  /**
   * 添加订阅（写入本地 PouchDB，自动同步到远端 CouchDB）
   */
  async function addSubscription(feedId: string, info: { title: string, siteUrl?: string, description?: string, image?: string }, category?: string) {
    const stateDb = getUserStateDb()
    await stateDb.put({
      _id: `subscription:${feedId}`,
      type: 'subscription',
      feedId,
      title: info.title,
      siteUrl: info.siteUrl,
      description: info.description,
      image: info.image,
      category,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * 删除订阅（移除本地文档，自动同步删除到远端）
   */
  async function removeSubscription(feedId: string) {
    const stateDb = getUserStateDb()
    const docId = `subscription:${feedId}`
    try {
      const doc = await stateDb.get(docId)
      await stateDb.remove(doc)
    } catch {
      // 文档不存在，忽略
    }
  }

  /**
   * 更新订阅元信息（显示名/分类）
   */
  async function updateSubscription(feedId: string, patch: { title?: string, category?: string }) {
    const stateDb = getUserStateDb()
    const docId = `subscription:${feedId}`
    const doc = await stateDb.get(docId)
    await stateDb.put({
      ...doc,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
    })
  }

  return {
    syncFeed,
    unsyncFeed,
    queryEntries,
    getEntry,
    getUserStateDb,
    markRead,
    toggleSaved,
    destroyAll,
    syncStatuses: syncStatuses as Readonly<Record<string, SyncStatus>>,
    listSubscriptions,
    addSubscription,
    removeSubscription,
    updateSubscription,
  }
}
