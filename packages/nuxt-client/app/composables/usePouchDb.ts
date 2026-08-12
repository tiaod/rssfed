import PouchDB from 'pouchdb'
import { reactive } from 'vue'
import type { RssEntry } from '~/types/rss'
import type { SubscriptionItem } from '~/composables/useCouchDb'

export interface SyncStatus {
  feedId: string
  status: 'syncing' | 'idle' | 'error'
  /** 同步版本号：每次有数据变化时递增，页面可 watch 后重新查询条目 */
  version: number
  error?: string
  /** 最近一次成功同步的时间，供 UI 展示 */
  lastSyncedAt?: string
}

/**
 * PouchDB 共享状态：通过 nuxtApp 单例化，确保所有组件使用同一份实例与同步状态。
 *
 * 之前每次调用 usePouchDb() 都会创建新的 dbs/syncHandles/syncStatuses，
 * 导致页面切换后 watch 监听的 syncStatuses 是空对象，已同步的数据无法触发刷新。
 */
interface PouchDbState {
  /** 当前已激活的 PouchDB 实例集合 */
  dbs: Map<string, PouchDB.Database>
  /** 同步句柄集合 */
  syncHandles: Map<string, PouchDB.Replication.Sync<{}>>
  /** 同步状态（响应式，供组件 watch） */
  syncStatuses: Record<string, SyncStatus>
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

  // 通过 nuxtApp 单例化共享状态，避免每次组件挂载都创建新实例
  const nuxtApp = useNuxtApp()
  if (!(nuxtApp as any).$pouchDbState) {
    ;(nuxtApp as any).$pouchDbState = {
      dbs: new Map<string, PouchDB.Database>(),
      syncHandles: new Map<string, PouchDB.Replication.Sync<{}>>(),
      syncStatuses: reactive<Record<string, SyncStatus>>({}),
    } as PouchDbState
  }
  const { dbs, syncHandles, syncStatuses } = (nuxtApp as any).$pouchDbState as PouchDbState

  /**
   * 启动某个 feed 的 live 双向同步（db 必须已创建）。
   * 与 syncFeed 分离，便于手动同步（syncNow）暂停后恢复实时同步。
   */
  function startFeedLiveSync(feedId: string) {
    const db = dbs.get(feedId)
    if (!db) return

    syncStatuses[feedId] = {
      feedId,
      status: 'syncing',
      version: syncStatuses[feedId]?.version ?? 0,
    }

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
          lastSyncedAt: new Date().toISOString(),
        }
      })
      .on('paused', (err) => {
        // live 同步没有 complete 事件：初始复制完成、进入等待变化时触发 paused，
        // err 为空表示正常暂停，此时标记为 idle（同步通道已建立）
        if (!err && syncStatuses[feedId]?.status !== 'idle') {
          syncStatuses[feedId] = {
            feedId,
            status: 'idle',
            version: syncStatuses[feedId]?.version ?? 0,
            lastSyncedAt: new Date().toISOString(),
          }
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
   * 获取或创建某个 feed 的 PouchDB 实例并开始同步
   */
  function syncFeed(feedId: string) {
    if (dbs.has(feedId)) return
    const db = new PouchDB(`rssfed-feed-${feedId}`)
    dbs.set(feedId, db)
    startFeedLiveSync(feedId)
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
   * 手动触发一次性同步：从远端拉取最新数据（live 同步之外的即时刷新）。
   *
   * 不传 feedIds 时同步所有已激活的 feed 与用户状态库；返回成功/失败清单供 UI 提示。
   * 实现要点：浏览器对同一主机（HTTP/1.1）并发连接数有限（约 6 个），
   * 多个 live 长轮询已占满连接，直接并发一次性复制会让请求饿死而挂起，
   * 因此先临时暂停相关库的 live 同步、串行复制，结束后再恢复实时同步。
   */
  async function syncNow(feedIds?: string[]): Promise<{ ok: string[], failed: { id: string, error: string }[] }> {
    // 目标集合：显式传入的 feed，或当前已激活的所有库
    const targets = feedIds?.length
      ? [...new Set(feedIds)]
      : Array.from(dbs.keys())

    const ok: string[] = []
    const failed: { id: string, error: string }[] = []

    // ① 临时暂停目标库的 live 同步，释放长轮询连接给一次性复制使用
    const pausedIds: string[] = []
    for (const id of targets) {
      const handle = syncHandles.get(id)
      if (handle && typeof handle.cancel === 'function') {
        handle.cancel()
        syncHandles.delete(id)
        pausedIds.push(id)
      }
    }

    // ② 串行执行一次性复制（每个库只占用一个连接）
    for (const id of targets) {
      const db = dbs.get(id)
      if (!db) continue

      const remoteUrl = id === '__user_state__'
        ? `${base}/api/couchdb/proxy/user-state`
        : `${base}/api/couchdb/proxy/feed/${encodeURIComponent(id)}`

      syncStatuses[id] = {
        feedId: id,
        status: 'syncing',
        version: syncStatuses[id]?.version ?? 0,
      }

      try {
        const res = await db.replicate.from(remoteUrl)
        if (!res.ok) {
          throw new Error(`复制失败（HTTP ${res.status}）`)
        }
        syncStatuses[id] = {
          feedId: id,
          status: 'idle',
          version: (syncStatuses[id]?.version ?? 0) + 1,
          lastSyncedAt: new Date().toISOString(),
        }
        ok.push(id)
      } catch (e: any) {
        syncStatuses[id] = {
          feedId: id,
          status: 'error',
          version: syncStatuses[id]?.version ?? 0,
          error: String(e?.message ?? e),
        }
        failed.push({ id, error: e?.message ?? String(e) })
      }
    }

    // ③ 恢复被暂停的 live 同步，保持实时同步的持续能力
    for (const id of pausedIds) {
      if (id === '__user_state__') {
        startUserStateLiveSync()
      } else {
        startFeedLiveSync(id)
      }
    }

    return { ok, failed }
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
    for (const [, db] of dbs.entries()) {
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
   * 启动用户状态库的 live 双向同步（db 必须已创建）。
   * 与 getUserStateDb 分离，便于手动同步（syncNow）暂停后恢复实时同步。
   */
  function startUserStateLiveSync() {
    const key = '__user_state__'
    const db = dbs.get(key)
    if (!db) return

    // 启动双向同步；错误写入 syncStatuses，供 UI 展示
    const remoteUrl = `${base}/api/couchdb/proxy/user-state`
    syncStatuses[key] = {
      feedId: key,
      status: 'syncing',
      version: syncStatuses[key]?.version ?? 0,
    }
    const sync = PouchDB.sync(db, remoteUrl, {
      live: true,
      retry: true,
    })
      .on('change', () => {
        syncStatuses[key] = {
          feedId: key,
          status: 'idle',
          version: (syncStatuses[key]?.version ?? 0) + 1,
          lastSyncedAt: new Date().toISOString(),
        }
      })
      .on('paused', (err) => {
        // 初始复制完成、进入等待变化时置为 idle（err 为空表示正常暂停）
        if (!err && syncStatuses[key]?.status !== 'idle') {
          syncStatuses[key] = {
            feedId: key,
            status: 'idle',
            version: syncStatuses[key]?.version ?? 0,
            lastSyncedAt: new Date().toISOString(),
          }
        }
      })
      .on('error', (err) => {
        syncStatuses[key] = {
          feedId: key,
          status: 'error',
          version: syncStatuses[key]?.version ?? 0,
          error: String(err),
        }
      })

    // 存入 handle，便于 syncNow 暂停/恢复
    syncHandles.set(key, sync)
  }

  /**
   * 获取用户状态库 PouchDB 实例（用于已读/收藏标记）
   */
  function getUserStateDb(): PouchDB.Database {
    const key = '__user_state__'
    if (!dbs.has(key)) {
      const db = new PouchDB('rssfed-user-state')
      dbs.set(key, db)
      startUserStateLiveSync()
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
    for (const [, handle] of syncHandles.entries()) {
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
    syncNow,
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
