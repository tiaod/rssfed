import PouchDB from 'pouchdb'
import * as PouchDBFindNS from 'pouchdb-find'
import { reactive } from 'vue'
import type { RssCachedImage, RssEntry } from '~/types/rss'
import type { SubscriptionItem } from '~/composables/useCouchDb'
import { useCouchTargets, USER_STATE_ID } from '~/composables/useCouchTargets'
import { errorMessage } from '~/utils/errorMessage'
import { LOCAL_VIEWS, TIMELINE_VIEW, BY_FEED_VIEW, VIEW_MAX_TS } from '~/utils/localViews'

// 注册 Mango 查询插件（db.find / createIndex）。
// pouchdb-find 是 CJS 模块，兼容 Vite 的 default interop 嵌套
const PouchDBFind = (PouchDBFindNS as { default?: typeof PouchDBFindNS }).default ?? PouchDBFindNS
PouchDB.plugin(PouchDBFind)

export interface SyncStatus {
  feedId: string
  status: 'syncing' | 'idle' | 'error' | 'queued'
  /** 同步版本号：每次有数据变化时递增，页面可 watch 后重新查询条目 */
  version: number
  error?: string
  /** 最近一次成功同步的时间，供 UI 展示 */
  lastSyncedAt?: string
}

/** 集中库里的 feed 文档（订阅源元信息，由远端 feed 库同步过来） */
interface FeedDoc {
  _id: string
  _rev: string
  type?: string
  title?: string
  url?: string
  siteUrl?: string
  lastFetchedAt?: string
  image?: string
  /** 已缓存为本地附件的图标（见 rss/entry-images.ts） */
  imageCached?: { attachment?: string }
}

/** 集中库里的条目文档 */
interface EntryDoc {
  _id: string
  _rev?: string
  type?: string
  feedId: string
  title?: string
  url?: string
  content?: string
  description?: string
  author?: string
  publishedAt: string
  insertedAt: string
  categories?: string[]
  images?: RssCachedImage[]
}

/** 用户状态库里的文档（按 type 区分 entry-state / subscription） */
interface StateDoc {
  _id: string
  _rev?: string
  type?: string
  entryId?: string
  feedId?: string
  read?: boolean
  readAt?: string
  saved?: boolean
  savedAt?: string
  title?: string
  siteUrl?: string
  description?: string
  image?: string
  category?: string
  createdAt?: string
  /** subscription 文档：订阅类型（默认 feed） */
  kind?: 'feed' | 'bot'
}

/** nuxtApp 上挂载的 PouchDB 共享状态（用 $ 前缀避免与 Nuxt 内部字段冲突） */
type NuxtAppWithPouchState = ReturnType<typeof useNuxtApp> & { $pouchDbState?: PouchDbState }

/**
 * PouchDB 共享状态：通过 nuxtApp 单例化，确保所有组件使用同一份实例与同步状态。
 *
 * 集中库架构：所有订阅源的条目单向同步到一个本地库（rssfed-entries），
 * 时间线只需一次索引查询（publishedAt 倒序），避免 per-feed 多库的
 * N 次查询与大量 PouchDB 实例常驻。已读/收藏等用户状态仍在独立库（live 双向同步）。
 */
interface PouchDbState {
  /** 集中条目库（所有订阅源条目的单向同步目标） */
  entriesDb: PouchDB.Database | null
  /** 用户状态库（已读/收藏/订阅，live 双向同步） */
  userStateDb: PouchDB.Database | null
  /** 本地条目视图是否已安装（避免每次重复 put 设计文档） */
  entriesIndexed: boolean
  /** 同步句柄集合（用户状态库 live 同步） */
  syncHandles: Map<string, PouchDB.Replication.Sync<Record<string, unknown>>>
  /** 同步状态（响应式，供组件 watch） */
  syncStatuses: Record<string, SyncStatus>
  /** 复制任务队列（限制并发，避免大量订阅源同时复制挤爆连接与 IndexedDB） */
  replicateWaiting: Array<{ id: string, full?: boolean, resolve: (r: { ok: boolean, error?: string }) => void }>
  /** 当前正在执行的复制数 */
  activeReplicates: number
  /** 用户状态库 live 同步的启动 Promise（syncNow 暂停它之前必须先等它挂上 handle） */
  userStateSyncPromise: Promise<void> | null
}

/** 集中条目库名称 */
const ENTRIES_DB_NAME = 'rssfed-entries'

/**
 * 管理 PouchDB 集中库同步，提供跨源条目查询能力。
 *
 * 每个订阅源通过单向复制（replicate.from）把条目同步到本地集中库，
 * 时间线/单源/分组查询走 Mango 索引（publishedAt 倒序）一次查询。
 * 用户状态库（已读/收藏/订阅）通过 live 双向同步。
 */
export function usePouchDb() {
  // 代理地址里的库名由后端下发（随机库名，无法推导），见 useCouchTargets
  const { remoteUrlForId, invalidate: invalidateTargets } = useCouchTargets()

  // 通过 nuxtApp 单例化共享状态，避免每次组件挂载都创建新实例
  const nuxtApp = useNuxtApp() as NuxtAppWithPouchState
  if (!nuxtApp.$pouchDbState) {
    nuxtApp.$pouchDbState = {
      entriesDb: null,
      userStateDb: null,
      entriesIndexed: false,
      syncHandles: new Map<string, PouchDB.Replication.Sync<Record<string, unknown>>>(),
      syncStatuses: reactive<Record<string, SyncStatus>>({}),
      replicateWaiting: [],
      activeReplicates: 0,
      userStateSyncPromise: null
    }
  }
  const { syncHandles, syncStatuses } = nuxtApp.$pouchDbState
  // 队列与集中库字段需通过对象引用读写（解构 number 会丢失状态）
  const pouchState = nuxtApp.$pouchDbState

  /** 迁移清理的幂等 Promise（避免并发重复执行） */
  let cleanupPromise: Promise<void> | null = null

  function ensureCleanup() {
    if (!cleanupPromise) cleanupPromise = cleanupLegacyFeedDbs()
    return cleanupPromise
  }

  /** 获取集中条目库（惰性创建，并顺带清理旧的 per-feed 本地库） */
  function getEntriesDb(): PouchDB.Database {
    if (!pouchState.entriesDb) {
      pouchState.entriesDb = new PouchDB(ENTRIES_DB_NAME)
      void ensureCleanup()
    }
    return pouchState.entriesDb
  }

  /**
   * 确保本地视图（map view）存在。掏空 Mango：PouchDB 9.0.0 的 find
   * 对自建索引做 desc 排序实测不可靠（会回退默认索引报错），而 db.query 的
   * map view 天然支持 descending + startkey 游标，只返回窗口行、不把巨量文档
   * 拉进内存排序。视图内容看 LOCAL_VIEWS。
   */
  async function ensureLocalViews() {
    if (pouchState.entriesIndexed) return
    const db = getEntriesDb()
    await db.put(LOCAL_VIEWS).catch((e: unknown) => {
      // 409 说明设计文档已存在（幂等），其余错误如实抛出方便排查
      if ((e as { status?: number })?.status !== 409) throw e
    })
    pouchState.entriesIndexed = true
  }

  /**
   * 迁移清理：删除旧的 per-feed 本地库（rssfed-feed-*）。
   * 集中库方案废弃多库结构，旧数据由集中库重新同步；一次性执行（localStorage 标记）。
   */
  /**
   * 迁移清理：删除旧的 per-feed 本地库（rssfed-feed-*）并重置增量记录。
   * 集中库方案废弃多库结构，旧数据由集中库重新同步；一次性执行（localStorage 标记）。
   * 注意：多标签页持有旧库连接时 destroy 可能被 blocked（永不返回），因此
   * 增量记录先清、删库限时放弃——保证集中库必定全量同步一次，删库失败只是残留磁盘。
   */
  async function cleanupLegacyFeedDbs() {
    try {
      // v2：集中库架构的迁移标记（与 per-feed 时代的 v1 区分，强制重新迁移一次）
      if (localStorage.getItem('rssfed-central-migrated-v2')) return
      // 先清增量记录：集中库全新，必须全量同步一次（无论删库是否成功）
      try {
        localStorage.removeItem(SYNCED_FEEDS_KEY)
      } catch {
        // localStorage 不可用时忽略
      }
      // 尝试删除旧 per-feed 库（限时 3 秒，超时放弃）
      try {
        // PouchDB 的静态方法（allDbs / destroy）不在类型定义里，这里按实际签名断言
        const pouchStatic = PouchDB as unknown as {
          allDbs: () => Promise<string[]>
          destroy: (name: string) => Promise<void>
        }
        const dbs: string[] = await pouchStatic.allDbs()
        const legacy = dbs.filter(name => name.startsWith('rssfed-feed-'))
        await Promise.race([
          Promise.all(legacy.map(name => pouchStatic.destroy(name).catch(() => {}))),
          new Promise(resolve => setTimeout(resolve, 3000))
        ])
      } catch {
        // 删库失败不影响主流程
      }
      localStorage.setItem('rssfed-central-migrated-v2', '1')
    } catch {
      // 清理失败不影响主流程（旧库残留只是占磁盘）
    }
  }

  /** 复制并发上限：浏览器对同一主机的并发连接有限（约 6），订阅源很多时
   * （OPML 批量导入可达数百个）并发复制会挤爆连接与 IndexedDB 事务导致卡死。 */
  const MAX_CONCURRENT_REPLICATE = 3

  /** 消费复制队列：空闲时从等待队列取出任务执行 */
  function pumpReplicateQueue() {
    while (pouchState.activeReplicates < MAX_CONCURRENT_REPLICATE && pouchState.replicateWaiting.length > 0) {
      const item = pouchState.replicateWaiting.shift()!
      pouchState.activeReplicates++
      // replicateDb 承诺以 { ok, error } 上报失败、不抛错；这里再兜一层 catch，
      // 保证任何意外异常都不会让入队的 Promise 悬空（否则 syncNow 的 Promise.all 会挂死）
      void replicateDb(item.id, item.full)
        .then(item.resolve)
        .catch((e: unknown) => item.resolve({ ok: false, error: errorMessage(e) }))
        .finally(() => {
          pouchState.activeReplicates--
          pumpReplicateQueue()
        })
    }
  }

  /**
   * 判断订阅 id 能否定位远端 CouchDB 库：feedId 不能为空串，bot 订阅还需要 botId。
   * 空 id 拼出的地址定位不到任何库，复制只会拿到失败结果并刷一堆无用请求。
   */
  function isValidDbId(id: unknown): id is string {
    if (typeof id !== 'string' || id.length === 0) return false
    if (id === USER_STATE_ID) return true
    if (id.startsWith('bot:')) return id.length > 'bot:'.length
    return true
  }

  /** 将一次复制加入队列执行（限制并发，返回该库的复制结果）。
   *  入队即标记为 queued，供进度条统计剩余数量；成功完成后记录同步时间。
   *  full=true 时强制全量同步（since: 0），用于手动同步按钮——库被删重建后
   *  checkpoint 的 seq 会大于远端（旧 seq 残留），增量同步会误判"无新变更"。 */
  function enqueueReplicate(id: string, full = false): Promise<{ ok: boolean, error?: string }> {
    // 兜底：无效 id 直接拒绝，不发出注定失败的复制请求（上游已过滤，这里防漏网）
    if (!isValidDbId(id)) {
      return Promise.resolve({
        ok: false,
        error: `订阅 id 无效（${JSON.stringify(id)}），已跳过同步`
      })
    }
    // 标记排队中（若尚未有状态记录）
    if (!syncStatuses[id]) {
      syncStatuses[id] = { feedId: id, status: 'queued', version: 0 }
    }
    return new Promise((resolve) => {
      pouchState.replicateWaiting.push({
        id,
        full,
        resolve: (r) => {
          if (r.ok) markSynced(id)
          resolve(r)
        }
      })
      pumpReplicateQueue()
    })
  }

  /**
   * 对指定订阅源执行一次性单向复制（远端 per-feed CouchDB → 本地集中库），
   * 并更新同步状态。增量由 PouchDB checkpoint 保证（每源独立记录同步位置）；
   * full=true 时强制全量（since: 0），见 enqueueReplicate 说明。
   */
  async function replicateDb(id: string, full = false): Promise<{ ok: boolean, error?: string }> {
    const db = id === USER_STATE_ID ? getUserStateDb() : getEntriesDb()

    // 远端地址必须带真实库名（后端随机生成、持久化在业务表上），先取寻址信息。
    // 取寻址信息本身也会失败（未登录、接口不可达），按同步失败上报而不是往上抛：
    // replicateDb 的契约是不抛错，抛出去会让队列里的 Promise 悬空。
    let remoteUrl: string | null = null
    let lookupError: string | null = null
    try {
      remoteUrl = await remoteUrlForId(id)
    } catch (e: unknown) {
      lookupError = errorMessage(e)
    }
    if (!remoteUrl) {
      const error = lookupError ?? `未取到订阅对应的 CouchDB 库名（${id}），已跳过同步`
      syncStatuses[id] = {
        feedId: id,
        status: 'error',
        version: syncStatuses[id]?.version ?? 0,
        error
      }
      return { ok: false, error }
    }

    syncStatuses[id] = {
      feedId: id,
      status: 'syncing',
      version: syncStatuses[id]?.version ?? 0
    }

    try {
      const res = await db.replicate.from(remoteUrl, full ? { since: 0 } : undefined)
      if (!res.ok) {
        throw new Error(`同步失败（HTTP ${res.status}）`)
      }
      syncStatuses[id] = {
        feedId: id,
        status: 'idle',
        version: (syncStatuses[id]?.version ?? 0) + 1,
        lastSyncedAt: new Date().toISOString()
      }
      return { ok: true }
    } catch (e: unknown) {
      syncStatuses[id] = {
        feedId: id,
        status: 'error',
        version: syncStatuses[id]?.version ?? 0,
        error: errorMessage(e)
      }
      return { ok: false, error: errorMessage(e) }
    }
  }

  /**
   * 将某个订阅源加入复制队列（同步到集中库）
   */
  function syncFeed(feedId: string) {
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
    // 等待迁移清理完成：首次迁移时旧增量记录会导致误跳过，需清空后全量同步一次
    await ensureCleanup()

    const needSync: string[] = []

    for (const f of feeds) {
      // 脏订阅文档（feedId 为空/缺失）无法定位远端库，跳过
      if (!isValidDbId(f.feedId)) continue
      if (!needsSync(f.feedId, f.lastNewEntryAt)) continue
      needSync.push(f.feedId)
    }

    for (const id of needSync) {
      void enqueueReplicate(id)
    }
    return needSync.length
  }

  /**
   * 手动触发一次性同步：同步所有订阅源（或指定源）到集中库。
   *
   * 不传 feedIds 时同步所有已激活的 feed 与用户状态库；返回成功/失败清单供 UI 提示。
   * 订阅源本身无 live 长轮询，无需暂停；仅需临时暂停用户状态库的 live 同步
   * （避免与一次性复制抢连接），复制完成后恢复实时同步。
   * 复制统一走并发受限队列（见 enqueueReplicate），订阅源很多时不会挤爆连接。
   */
  async function syncNow(feedIds?: string[]): Promise<{ ok: string[], failed: { id: string, error: string }[] }> {
    // 目标集合：显式传入的 feed，或当前已订阅的全部源 + 用户状态库。
    // 订阅列表从 user-state 库读取（syncStatuses 是会话状态，刷新后为空，不能作为依据）
    let targets: string[]
    if (feedIds?.length) {
      targets = [...new Set(feedIds)].filter(isValidDbId)
    } else {
      const subs = await listSubscriptions()
      targets = [...new Set([...subs.map(s => s.id), USER_STATE_ID])].filter(isValidDbId)
    }

    // ① 临时暂停用户状态库的 live 同步，释放长轮询连接给一次性复制使用。
    // 先等 live 同步启动完成：它要先取库名（异步），否则 handle 还没挂上，暂停会落空
    await pouchState.userStateSyncPromise
    const pausedUserState = syncHandles.has(USER_STATE_ID)
    if (pausedUserState) {
      syncHandles.get(USER_STATE_ID)!.cancel()
      syncHandles.delete(USER_STATE_ID)
    }

    // ② 入队执行一次性复制（队列内部限制并发，等待全部完成）。
    // 手动同步强制全量（since: 0）：库重建后 checkpoint 残留旧 seq 会误判无变更
    const results = await Promise.all(targets.map(id => enqueueReplicate(id, true)))
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
      void startUserStateLiveSync()
    }

    return { ok, failed }
  }

  // ── 集中库查询（Mango 索引，一次查询） ──

  /**
   * feed 图标 blob 缓存（按 feedId + _rev 失效；FeedDoc 更新后自动重新生成）。
   * blob 数量与 feed 数相当，会话内不回收。
   */
  const feedIconBlobs = new Map<string, { rev: string, url: string }>()

  /** 从集中库 FeedDoc 解析 feed 图标：AVIF 附件 blob 优先，回退原始 URL；无图标返回 null */
  async function resolveFeedImage(feedDoc: FeedDoc | null): Promise<string | null> {
    if (!feedDoc) return null
    const cached = feedDoc.imageCached as { attachment?: string } | undefined
    if (cached?.attachment) {
      const hit = feedIconBlobs.get(feedDoc._id)
      if (hit && hit.rev === feedDoc._rev) return hit.url
      try {
        const blob = await getEntriesDb().getAttachment(feedDoc._id, cached.attachment) as unknown as Blob
        const url = URL.createObjectURL(blob)
        if (hit) URL.revokeObjectURL(hit.url) // 附件更新后回收旧 blob
        feedIconBlobs.set(feedDoc._id, { rev: feedDoc._rev, url })
        return url
      } catch {
        // 附件尚未同步到本地：回退原始 URL
      }
    }
    return feedDoc.image ?? null
  }

  /**
   * 条目封面图 blob 缓存（按 entryId + 附件名失效），列表缩略图用。
   * 与 feed 图标一样，会话内不回收（数量与条目数相当，均为小体积 AVIF）。
   */
  const entryCoverBlobs = new Map<string, string>()

  /**
   * 补全条目的 feed 元信息（源名/站点/图标）与封面图 blob。
   * FeedDoc 随库同步到集中库（replicate 无 filter），一次 allDocs 读取全部所需文档；
   * 图标优先本地缓存的 AVIF 附件（blob URL），离线可用；无缓存回退原始 URL。
   */
  async function enrichEntries(entries: RssEntry[]): Promise<RssEntry[]> {
    if (entries.length === 0) return entries
    const feedIds = [...new Set(entries.map(e => e.feedId))]
    let docs: FeedDoc[] = []
    try {
      const res = await getEntriesDb().allDocs({ include_docs: true, keys: feedIds })
      docs = (res.rows as Array<{ doc?: FeedDoc }>)
        .map(r => r.doc)
        .filter((d): d is FeedDoc => Boolean(d))
    } catch {
      return entries
    }
    const byId = new Map(docs.map(d => [d._id, d]))
    for (const entry of entries) {
      // 封面图：images 中 cover 标记的附件 → 本地 blob
      const cover = entry.images?.find(i => i.cover)
      if (cover?.attachment) {
        const cacheKey = `${entry.id}:${cover.attachment}`
        const hit = entryCoverBlobs.get(cacheKey)
        if (hit) {
          entry.coverUrl = hit
        } else {
          try {
            const blob = await getEntriesDb().getAttachment(entry.id, cover.attachment) as unknown as Blob
            const url = URL.createObjectURL(blob)
            entryCoverBlobs.set(cacheKey, url)
            entry.coverUrl = url
          } catch {
            // 附件未同步：不显示缩略图
          }
        }
      }
      const doc = byId.get(entry.feedId)
      if (!doc) continue
      entry.feed = {
        id: doc._id,
        title: doc.title ?? '',
        siteUrl: doc.siteUrl ?? '',
        feedUrl: doc.url ?? '',
        image: (await resolveFeedImage(doc)) ?? undefined,
        lastFetchedAt: doc.lastFetchedAt ?? ''
      }
    }
    return entries
  }

  /**
   * 清空本地缓存并重置同步状态（不删除远端数据）。
   *
   * 适用场景：本地库数据与服务端冲突/损坏（如服务端库重建后本地 rev 冲突
   * 导致旧数据残留），清空后下次同步会全量重建本地库。
   */
  async function resetLocalData() {
    // 销毁集中条目库（旧数据/冲突分支一并清除），下次访问自动重建空库
    if (pouchState.entriesDb) {
      await pouchState.entriesDb.destroy().catch(() => {})
      pouchState.entriesDb = null
    }
    pouchState.entriesIndexed = false
    feedIconBlobs.clear()
    entryCoverBlobs.clear()
    // 清掉增量同步记录，确保下次同步不因「已同步过」而跳过
    try {
      localStorage.removeItem(SYNCED_FEEDS_KEY)
    } catch {
      // localStorage 不可用时忽略
    }
    // 同步状态重置为未同步（relatedIds 依赖它判断全量同步目标）
    // 用 Reflect.deleteProperty 而不是 delete：后者对动态键会破坏 V8 的对象形状优化
    for (const key of Object.keys(syncStatuses)) {
      Reflect.deleteProperty(syncStatuses, key)
    }
    // 代理寻址信息一并失效：服务端库重建后库名可能已变
    invalidateTargets()
  }

  /**
   * 获取 feed 图标的可展示 URL（AVIF 附件 blob 优先，回退原始 URL），
   * 供订阅管理页等未走条目查询的场景使用。
   */
  async function getFeedImageUrl(feedId: string, fallback?: string): Promise<string | null> {
    try {
      const doc = await getEntriesDb().get(feedId) as unknown as FeedDoc
      if (doc?.type === 'feed') {
        const url = await resolveFeedImage(doc)
        if (url) return url
      }
    } catch {
      // FeedDoc 尚未同步，走回退
    }
    return fallback ?? null
  }

  /** 将集中库文档映射为 RssEntry（列表展示用，feed 元信息由 enrichEntries 补全） */
  function docToEntry(doc: EntryDoc): RssEntry {
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
      images: doc.images,
      feed: {
        id: doc.feedId,
        title: '',
        siteUrl: '',
        feedUrl: '',
        lastFetchedAt: ''
      },
      starred: false,
      read: false,
      readingTime: 0
    }
  }

  /**
   * 集中库查询：走本地 map view，desc 只取一页窗口，不再把全库文档拉进内存排序。
   *
   * 背景：PouchDB 9 的 Mango（pouchdb-find）对自建索引无法可靠做 desc 排序，
   * 旧实现退化为 find 一次拉 1 万条 + JS 整体排序，翻页还会重复整库查询，
   * 内存被不断顶高（浏览器端是只读模型，翻页 O(全库)）。map view 的
   * descending + limit 由 PouchDB 在索引 B 树上完成，单次开销 O(窗口大小)。
   *
   * viewName: 'local_entries_v1/timeline' | 'local_entries_v1/by_feed'
   * bucket: by_feed 时限定单个 feedId 桶的起扫端点；timeline 传 undefined。
   */

  /** 把视图 value 投影还原为 RssEntry（行已按发布时间倒序，保留顺序） */
  function rowToEntry(row: { value?: Record<string, unknown> }): RssEntry {
    return docToEntry({ ...row.value } as unknown as EntryDoc)
  }

  /** 视图翻页：翻转窗口大小下取分桶最新条目（不补全 feed 元信息，由调用方统一 enrich） */
  async function queryByView(view: string, feedId: string | undefined, limit: number): Promise<RssEntry[]> {
    const db = getEntriesDb()
    await ensureLocalViews()
    const opts: Record<string, unknown> = { descending: true, include_docs: false, reduce: false, limit }
    // 限定到 feed 桶内：desc 起点取该 feed 最新的一条（startkey=[feedId, MAX, '']）。
    // 关键：desc 只给 startkey 会沿索引一路扫到开头，越过桶底串进其它 feed；
    // 必须再用 endkey=[feedId] 兜住桶底。数组键里 [feedId] 排在全部 [feedId,*] 之前，
    // 且不会有行恰等于该键，因此正好在不漏本桶的同时把扫描截断在桶边界。
    if (feedId !== undefined) {
      opts.startkey = [feedId, VIEW_MAX_TS, '']
      opts.endkey = [feedId]
    }
    try {
      const res = await db.query(view, opts)
      return res.rows.map(rowToEntry)
    } catch {
      return []
    }
  }

  /** 时间线：一次性查询所有订阅源的最新条目（走全局视图，最新在前） */
  async function queryTimeline(limit = 50): Promise<RssEntry[]> {
    return enrichEntries(await queryByView(TIMELINE_VIEW, undefined, limit))
  }

  /** 单个订阅源的最新条目 */
  async function queryFeedEntries(feedId: string, limit = 50): Promise<RssEntry[]> {
    return enrichEntries(await queryByView(BY_FEED_VIEW, feedId, limit))
  }

  /**
   * 分组（多个订阅源）的最新条目：每个源各浅取一页，再归并出全局前 limit 条。
   * 正确性：全局前 L 条中的任意一条，必然位于它所处源的前 L（否则该源上有
   * 至少 L 条更新的条目，足以把它挤出并集前 L），因此每源只取 L 条足够精确。
   */
  async function queryGroupEntries(feedIds: string[], limit = 50): Promise<RssEntry[]> {
    if (feedIds.length === 0) return []
    const perFeed = await Promise.all(
      feedIds.map(id => queryByView(BY_FEED_VIEW, id, limit))
    )
    const ptr = perFeed.map(() => 0)
    const merged: RssEntry[] = []
    while (merged.length < limit) {
      let bestIdx = -1
      let bestTs = -Infinity
      for (let i = 0; i < perFeed.length; i++) {
        const at = ptr[i]!
        const e = perFeed[i]![at]
        if (!e) continue
        const ts = new Date(e.publishedAt).getTime()
        if (ts > bestTs) {
          bestTs = ts
          bestIdx = i
        }
      }
      if (bestIdx === -1) break
      merged.push(perFeed[bestIdx]![ptr[bestIdx]!]!)
      ptr[bestIdx]!++
    }
    return enrichEntries(merged)
  }

  /**
   * 获取单条条目的完整内容
   */
  async function getEntry(entryId: string): Promise<RssEntry | null> {
    try {
      const doc = await getEntriesDb().get(entryId) as unknown as EntryDoc
      if (doc && doc.type === 'entry') {
        const entry = docToEntry(doc)
        return (await enrichEntries([entry]))[0] ?? entry
      }
    } catch {
      // 条目不存在
    }
    return null
  }

  /**
   * 获取条目缓存的图片附件（AVIF）二进制，用于生成 blob URL 直接展示。
   * 附件随文档同步到本地库，离线可用；不存在时抛出，调用方回退原 URL。
   * 注：PouchDB 类型声明为 Blob | Buffer，浏览器环境实际为 Blob，这里按 Blob 处理。
   */
  async function getEntryAttachment(entryId: string, attachmentName: string): Promise<Blob> {
    return await getEntriesDb().getAttachment(entryId, attachmentName) as Blob
  }

  // ── 用户状态库（已读/收藏/订阅，live 双向同步） ──

  /**
   * 启动用户状态库的 live 双向同步（db 必须已创建）。
   * 与 getUserStateDb 分离，便于手动同步（syncNow）暂停后恢复实时同步。
   */
  async function startUserStateLiveSync() {
    const key = USER_STATE_ID
    const db = pouchState.userStateDb
    if (!db) return

    // 远端地址要带真实库名，先取寻址信息；取不到就记错误，等下次触发再试。
    // 这里也不能往上抛：返回值会作为 userStateSyncPromise 被 syncNow await。
    let remoteUrl: string | null = null
    let lookupError: string | null = null
    try {
      remoteUrl = await remoteUrlForId(key)
    } catch (e: unknown) {
      lookupError = errorMessage(e)
    }
    if (!remoteUrl) {
      syncStatuses[key] = {
        feedId: key,
        status: 'error',
        version: syncStatuses[key]?.version ?? 0,
        error: lookupError ?? '未取到用户状态库名，实时同步未启动'
      }
      return
    }

    // 启动双向同步；错误写入 syncStatuses，供 UI 展示
    syncStatuses[key] = {
      feedId: key,
      status: 'syncing',
      version: syncStatuses[key]?.version ?? 0
    }
    const sync = PouchDB.sync(db, remoteUrl, {
      live: true,
      retry: true
    })
      .on('change', () => {
        syncStatuses[key] = {
          feedId: key,
          status: 'idle',
          version: (syncStatuses[key]?.version ?? 0) + 1,
          lastSyncedAt: new Date().toISOString()
        }
      })
      .on('paused', (err) => {
        // 初始复制完成、进入等待变化时置为 idle（err 为空表示正常暂停）
        if (!err && syncStatuses[key]?.status !== 'idle') {
          syncStatuses[key] = {
            feedId: key,
            status: 'idle',
            version: syncStatuses[key]?.version ?? 0,
            lastSyncedAt: new Date().toISOString()
          }
        }
      })
      .on('error', (err) => {
        syncStatuses[key] = {
          feedId: key,
          status: 'error',
          version: syncStatuses[key]?.version ?? 0,
          error: String(err)
        }
      })

    // 存入 handle，便于 syncNow 暂停/恢复
    syncHandles.set(key, sync)
  }

  /**
   * 获取用户状态库 PouchDB 实例（用于已读/收藏标记）
   */
  function getUserStateDb(): PouchDB.Database {
    if (!pouchState.userStateDb) {
      pouchState.userStateDb = new PouchDB('rssfed-user-state')
      // 记下启动 Promise：syncNow 要等它挂上 handle 才能暂停 live 同步
      pouchState.userStateSyncPromise = startUserStateLiveSync()
    }
    return pouchState.userStateDb
  }

  /**
   * 标记条目为已读
   */
  async function markRead(entryId: string, feedId: string, read: boolean) {
    const stateDb = getUserStateDb()
    const docId = `entry-state:${entryId}`

    try {
      const existing = await stateDb.get(docId) as unknown as StateDoc
      await stateDb.put({
        ...existing,
        read,
        readAt: read ? new Date().toISOString() : undefined
      })
    } catch {
      await stateDb.put({
        _id: docId,
        type: 'entry-state',
        entryId,
        feedId,
        read,
        readAt: read ? new Date().toISOString() : undefined,
        saved: false
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
      const existing = await stateDb.get(docId) as unknown as StateDoc
      await stateDb.put({
        ...existing,
        saved: !existing.saved,
        savedAt: !existing.saved ? new Date().toISOString() : undefined
      })
    } catch {
      await stateDb.put({
        _id: docId,
        type: 'entry-state',
        entryId,
        feedId,
        read: false,
        saved: true,
        savedAt: new Date().toISOString()
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
    pouchState.userStateSyncPromise = null
    // 代理寻址信息与账号绑定，销毁本地状态时一并失效（登出/切换用户后不能沿用旧库名）
    invalidateTargets()
    if (pouchState.entriesDb) {
      pouchState.entriesDb.close()
      pouchState.entriesDb = null
    }
    if (pouchState.userStateDb) {
      pouchState.userStateDb.close()
      pouchState.userStateDb = null
    }
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
      endkey: 'subscription:\uffff'
    })
    return result.rows
      .map(r => r.doc as unknown as StateDoc)
      .filter(doc => doc?.type === 'subscription')
      // 过滤脏文档：feedId 缺失/为空串的订阅定位不到远端库，同步注定失败
      .filter(doc => isValidDbId(doc.feedId))
      .map(doc => ({
        id: doc.feedId!,
        title: doc.title ?? '',
        siteUrl: doc.siteUrl,
        description: doc.description,
        image: doc.image,
        category: doc.category,
        createdAt: doc.createdAt ?? new Date().toISOString(),
        kind: doc.kind === 'bot' ? 'bot' as const : 'feed' as const
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
      createdAt: new Date().toISOString()
    })
    // 新订阅的库名还不在代理寻址缓存里，失效后下次同步重新取
    invalidateTargets()
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
    // 订阅集合变了，下次同步重新取寻址信息（服务端已删掉对应库名映射）
    invalidateTargets()
  }

  /**
   * 订阅 Bot 产出（写入本地 PouchDB，自动同步到远端 CouchDB）。
   * doc 的 feedId 为 `bot:{botId}`（虚拟 feed），kind 标记 bot 类型，
   * 与 feed 订阅共用 `subscription:` 前缀，但 _id 带 `bot:` 避免与真实 feed 撞 key。
   */
  async function addBotSubscription(botId: string, info: { title: string, description?: string, image?: string }) {
    const stateDb = getUserStateDb()
    await stateDb.put({
      _id: `subscription:bot:${botId}`,
      type: 'subscription',
      feedId: `bot:${botId}`,
      kind: 'bot',
      title: info.title,
      description: info.description,
      image: info.image,
      createdAt: new Date().toISOString()
    })
    // 新订阅的库名还不在代理寻址缓存里，失效后下次同步重新取
    invalidateTargets()
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
      ...(patch.category !== undefined ? { category: patch.category } : {})
    })
  }

  return {
    syncFeed,
    syncFeedsIfChanged,
    syncNow,
    queryTimeline,
    queryFeedEntries,
    queryGroupEntries,
    getEntry,
    getEntryAttachment,
    getFeedImageUrl,
    resetLocalData,
    getUserStateDb,
    markRead,
    toggleSaved,
    destroyAll,
    syncStatuses: syncStatuses as Readonly<Record<string, SyncStatus>>,
    listSubscriptions,
    addSubscription,
    addBotSubscription,
    removeSubscription,
    updateSubscription
  }
}
