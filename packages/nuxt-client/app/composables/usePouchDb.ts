import PouchDB from 'pouchdb'
import { reactive } from 'vue'
import type { RssEntry } from '~/types/rss'
import type { SubscriptionItem } from '~/composables/useCouchDb'

export interface SyncStatus {
  feedId: string
  status: 'syncing' | 'idle' | 'error' | 'queued'
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
  /** 复制任务队列（限制并发，避免大量订阅源同时复制挤爆连接与 IndexedDB） */
  replicateWaiting: Array<{ id: string, resolve: (r: { ok: boolean, error?: string }) => void }>
  /** 当前正在执行的复制数 */
  activeReplicates: number
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
      replicateWaiting: [],
      activeReplicates: 0,
    } as PouchDbState
  }
  const { dbs, syncHandles, syncStatuses } = (nuxtApp as any).$pouchDbState as PouchDbState
  // 队列字段需通过对象引用读写（解构 number 会丢失状态）
  const pouchState = (nuxtApp as any).$pouchDbState as PouchDbState

  /** 复制并发上限：浏览器对同一主机的并发连接有限（约 6），订阅源很多时
   * （OPML 批量导入可达数百个）并发复制会挤爆连接与 IndexedDB 事务导致卡死。 */
  const MAX_CONCURRENT_REPLICATE = 3

  /** 消费复制队列：空闲时从等待队列取出任务执行 */
  function pumpReplicateQueue() {
    while (pouchState.activeReplicates < MAX_CONCURRENT_REPLICATE && pouchState.replicateWaiting.length > 0) {
      const item = pouchState.replicateWaiting.shift()!
      pouchState.activeReplicates++
      void replicateDb(item.id).then(item.resolve).finally(() => {
        pouchState.activeReplicates--
        pumpReplicateQueue()
      })
    }
  }

  /** 将一次复制加入队列执行（限制并发，返回该库的复制结果）。
   *  入队即标记为 queued，供进度条统计剩余数量；成功完成后记录同步时间。 */
  function enqueueReplicate(id: string): Promise<{ ok: boolean, error?: string }> {
    // 标记排队中（若尚未有状态记录）
    if (!syncStatuses[id]) {
      syncStatuses[id] = { feedId: id, status: 'queued', version: 0 }
    }
    return new Promise((resolve) => {
      pouchState.replicateWaiting.push({
        id,
        resolve: (r) => {
          if (r.ok) markSynced(id)
          resolve(r)
        },
      })
      pumpReplicateQueue()
    })
  }

  /**
   * 对指定库执行一次性复制（拉取远端最新数据到本地），并更新同步状态。
   *
   * 订阅源（feed 库）统一走一次性同步而非 live 长轮询：浏览器对同一主机的
   * 并发连接数有限（HTTP/1.1 约 6 个），多个 live 长轮询会互相饿死；且订阅源
   * 数据由后端抓取写入、实时推送意义不大，页面进入时拉取 + 手动同步即可。
   * 用户状态库（已读/收藏）仍保留 live 同步，见 startUserStateLiveSync。
   */
  async function replicateDb(id: string): Promise<{ ok: boolean, error?: string }> {
    const db = dbs.get(id)
    if (!db) return { ok: true }

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
        throw new Error(`同步失败（HTTP ${res.status}）`)
      }
      syncStatuses[id] = {
        feedId: id,
        status: 'idle',
        version: (syncStatuses[id]?.version ?? 0) + 1,
        lastSyncedAt: new Date().toISOString(),
      }
      return { ok: true }
    } catch (e: any) {
      syncStatuses[id] = {
        feedId: id,
        status: 'error',
        version: syncStatuses[id]?.version ?? 0,
        error: String(e?.message ?? e),
      }
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /**
   * 获取或创建某个 feed 的 PouchDB 实例并执行一次性同步（入队，限制并发）
   */
  function syncFeed(feedId: string) {
    if (dbs.has(feedId)) return
    const db = new PouchDB(`rssfed-feed-${feedId}`)
    dbs.set(feedId, db)
    void enqueueReplicate(feedId)
  }

  /**
   * 增量同步：根据每个源「最后抓到新条目的时间」（后端 feeds.lastNewEntryAt）
   * 只同步「上次同步后有过新内容」或「从未同步过」的源，其余直接跳过（连复制
   * 请求都不发）。订阅源很多（OPML 批量导入可达数百个）时避免每次进入时间线
   * 都对所有源发起复制请求。
   *
   * 每个源上次同步完成时间持久化在 localStorage，跨会话生效。
   */
  const SYNCED_FEEDS_KEY = 'rssfed-synced-feeds'

  function loadSyncedFeeds(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(SYNCED_FEEDS_KEY) ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }

  /** 记录某个源本次同步完成时间（仅同步成功时） */
  function markSynced(feedId: string) {
    try {
      const map = loadSyncedFeeds()
      map[feedId] = new Date().toISOString()
      localStorage.setItem(SYNCED_FEEDS_KEY, JSON.stringify(map))
    } catch {
      // localStorage 不可用时忽略（同步本身不受影响）
    }
  }

  /** 判断某个源是否需要同步：从未同步过（首次/新订阅）或上次同步后有过新内容 */
  function needsSync(feedId: string, lastNewEntryAt?: string): boolean {
    if (!lastNewEntryAt) return false // 服务器从未抓到新条目，没有可拉取的内容
    const lastSynced = loadSyncedFeeds()[feedId]
    if (!lastSynced) return true
    return lastNewEntryAt > lastSynced
  }

  async function syncFeedsIfChanged(feeds: Array<{ feedId: string, lastNewEntryAt?: string }>) {
    const needSync: string[] = []

    for (const f of feeds) {
      if (dbs.has(f.feedId)) continue // 本会话已激活（已同步或已入队）
      // 无论是否需要复制都要创建本地 db：queryEntries 依赖本地实例读取已缓存的数据
      const db = new PouchDB(`rssfed-feed-${f.feedId}`)
      dbs.set(f.feedId, db)
      if (!needsSync(f.feedId, f.lastNewEntryAt)) continue
      needSync.push(f.feedId)
    }

    for (const id of needSync) {
      void enqueueReplicate(id)
    }
    return needSync.length
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
   * 手动触发一次性同步：从远端拉取最新数据（feed 为一次性同步之外的即时刷新）。
   *
   * 不传 feedIds 时同步所有已激活的 feed 与用户状态库；返回成功/失败清单供 UI 提示。
   * 订阅源本身无 live 长轮询，无需暂停；仅需临时暂停用户状态库的 live 同步
   * （避免与一次性复制抢连接），复制完成后恢复实时同步。
   * 复制统一走并发受限队列（见 enqueueReplicate），订阅源很多时不会挤爆连接。
   */
  async function syncNow(feedIds?: string[]): Promise<{ ok: string[], failed: { id: string, error: string }[] }> {
    // 目标集合：显式传入的 feed，或当前已激活的所有库
    const targets = feedIds?.length
      ? [...new Set(feedIds)]
      : Array.from(dbs.keys())

    // ① 临时暂停用户状态库的 live 同步，释放长轮询连接给一次性复制使用
    const pausedUserState = syncHandles.has('__user_state__')
    if (pausedUserState) {
      syncHandles.get('__user_state__')!.cancel()
      syncHandles.delete('__user_state__')
    }

    // ② 入队执行一次性复制（队列内部限制并发），等待全部完成
    const results = await Promise.all(targets.map(id => enqueueReplicate(id)))
    const ok: string[] = []
    const failed: { id: string, error: string }[] = []
    targets.forEach((id, i) => {
      const r = results[i]!
      if (r.ok) {
        ok.push(id)
      } else {
        failed.push({ id, error: r.error ?? '未知错误' })
      }
    })

    // ③ 恢复用户状态库的 live 同步，保持已读/收藏的实时双向同步
    if (pausedUserState) {
      startUserStateLiveSync()
    }

    return { ok, failed }
  }

  /**
   * 从本地 PouchDB 查询条目，按时间倒序。
   * 订阅源较多时分批并发查询（每批 20 个库），避免串行全查过慢。
   */
  async function queryEntries(feedIds: string[], limit = 50): Promise<RssEntry[]> {
    const allEntries: RssEntry[] = []
    const BATCH = 20

    for (let i = 0; i < feedIds.length; i += BATCH) {
      const batch = feedIds.slice(i, i + BATCH)
      const batchResults = await Promise.all(batch.map(async (feedId) => {
        const db = dbs.get(feedId)
        if (!db) return []

        try {
          const result = await db.allDocs({
            include_docs: true,
            startkey: 'entry:',
            endkey: 'entry:\uffff',
            limit,
          })

          const entries: RssEntry[] = []
          for (const row of result.rows) {
            const doc = row.doc as any
            if (!doc || doc.type !== 'entry') continue
            entries.push({
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
          return entries
        } catch {
          // DB may not have synced yet
          return []
        }
      }))

      for (const entries of batchResults) {
        allEntries.push(...entries)
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
    syncFeedsIfChanged,
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
