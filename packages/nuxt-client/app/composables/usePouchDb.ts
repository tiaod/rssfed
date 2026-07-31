import PouchDB from 'pouchdb'
import type { RssEntry } from '~/types/rss'

export interface SyncStatus {
  feedId: string
  status: 'syncing' | 'idle' | 'error'
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
    syncStatuses[feedId] = { feedId, status: 'syncing' }

    const remoteUrl = `${base}/api/couchdb/proxy/feed/${encodeURIComponent(feedId)}`
    const sync = PouchDB.sync(db, remoteUrl, {
      live: true,
      retry: true,
    })
      .on('change', () => {
        syncStatuses[feedId] = { feedId, status: 'idle' }
      })
      .on('error', (err) => {
        syncStatuses[feedId] = { feedId, status: 'error', error: String(err) }
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
  }
}
