import PouchDB from 'pouchdb'
import * as PouchDBFindNS from 'pouchdb-find'
import { reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { FeedSubscriptionItem, RssCachedImage, RssEntry, SubscriptionItem } from '~/types/rss'
import { useCouchTargets, USER_STATE_ID } from '~/composables/useCouchTargets'
import { useApi } from '~/composables/useApi'
import { needsSync, pickFeedsNeedingSync, isStorageFailure, normalizeMark, type RetryMap, type SyncedMap } from '~/utils/syncDecision'
import { useUserStore } from '~/stores/user'
import { errorMessage } from '~/utils/errorMessage'
import { localDbName, syncedFeedsKey, syncRetryKey, LEGACY_LOCAL_DB_NAMES } from '~/utils/localDbName'
import { LOCAL_VIEWS, TIMELINE_VIEW, BY_FEED_VIEW, VIEW_MAX_TS } from '~/utils/localViews'
import { isListView, type ListView } from '~/utils/listViews'

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
  /**
   * 单个订阅源内部的拉取进度（0-100，整数）。
   *
   * 来自复制任务的 `change` 事件（见 replicateDb）：`docs_written` 是已写入数，
   * `pending` 是服务端 `_changes` 返回的剩余变更数（CouchDB 2.0+ 才带）。
   * undefined 表示还没有可用的进度信息（刚入队、或服务端没返回 pending），
   * UI 不能把 undefined 当作 0 来确定地展示。
   */
  progress?: number
  /** 本次复制已写入的文档数（change 事件的 docs_written，供 UI 显示「已同步 N 条」） */
  docsWritten?: number
  /** 本次复制在服务端剩余待拉取的变更数（change 事件的 pending，0 表示已拉完） */
  pending?: number
}

/**
 * 一次复制的结果。
 *
 * cancelled 表示「用户主动暂停同步」而非失败：调用方据此不弹失败提示，
 * 也不写 error 状态（暂停时状态已被统一归位）。
 */
export interface ReplicateResult {
  ok: boolean
  error?: string
  cancelled?: boolean
}

/**
 * 手动同步（syncNow）的结果。
 *
 * ok / failed 是逐目标的复制结果，skipped 是被增量过滤跳过（远端无更新）的目标数。
 *
 * added 是本轮**真正写入本地的文档数**（按目标前后差值统计）。它是「这次同步有没有带来
 * 新条目」的唯一判据：为 0 时列表页可以放心把攒着的新条目上屏（同步什么都没带来，
 * 不会把用户正在读的内容推走）。
 */
export interface SyncNowResult {
  ok: string[]
  failed: Array<{ id: string, error: string }>
  skipped: number
  cancelled: number
  added: number
}

/**
 * 复制任务的句柄中本模块用到的部分。
 *
 * 除 cancel 外还要 on / removeListener：源内进度来自复制的 change 事件。
 *
 * 这里**故意不直接用 PouchDB 的 Replication 类型**：它的 `on` 是按事件名
 * （`'change'` / `'error'` / …）重载的，与本模块只关心 change 的简化签名不兼容，
 * 直接约束会在赋值处报错（见 replicateDb 里的显式断言）。
 */
interface ReplicationTaskHandle {
  cancel: () => void
  on?: (event: 'change', listener: (info: { docs_written?: number, pending?: number }) => void) => unknown
  removeListener?: (event: 'change', listener: (info: { docs_written?: number, pending?: number }) => void) => unknown
}

/**
 * 进行中的一次性复制：任务句柄 + 取消标记。
 *
 * 取消（task.cancel）会让复制的 Promise 以错误 reject，光看错误分不清「用户暂停」
 * 与真正的同步失败，因此必须带上这个标记（见 replicateDb / pauseSync）。
 */
interface ActiveReplication {
  task: ReplicationTaskHandle
  markCancelled: () => void
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
  /**
   * subscription / group-pref 文档：该订阅源 / 该分组配置的默认列表视图。
   *
   * 存字符串（不是 ListView 联合类型）：文档来自远端，可能被老版本或手改写脏，
   * 读取时统一用 listViews 的 isListView 校验后再回退。
   */
  view?: string
  /** group-pref 文档：分组名（等于订阅文档上的 category） */
  name?: string
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
  replicateWaiting: Array<{ id: string, full?: boolean, seen?: string, resolve: (r: ReplicateResult) => void }>
  /** 当前正在执行的复制数 */
  activeReplicates: number
  /** 进行中的一次性复制（用户暂停 / 切换账号时逐一取消） */
  activeReplications: Set<ActiveReplication>
  /** 用户暂停同步（左下角指示器点击暂停）：暂停期间不再入队新的复制 */
  paused: Ref<boolean>
  /** 用户状态库 live 同步的启动 Promise（syncNow 暂停它之前必须先等它挂上 handle） */
  userStateSyncPromise: Promise<void> | null
  /** 当前本地实例所属的账号 id：本地库按账号隔离，见 switchUser */
  dbUserId: string | null
  /** 账号切换监听是否已注册（多个组件都会调用 usePouchDb，只需注册一次） */
  userWatchReady: boolean
  /**
   * 各订阅源「累计同步写入的文档数」（只增不减）。
   *
   * 数字来自复制任务的 change 事件（`docs_written`，见 replicateDb）。条目列表页据此
   * 显示「已同步 N 条」：同步只负责拉数据并报数，列表什么时候换成最新由用户点提示条决定
   * （见 composables/useSyncedEntryList）。
   */
  syncedDocsByFeed: Record<string, number>
  /**
   * 本地存储故障（IndexedDB 配额耗尽 / 库进入 global failure）的说明文案。
   *
   * 非 null 表示本轮同步已熔断：不再入队新复制，也不再发起在途复制 ——
   * 此时唯一有效动作是重置本地缓存。会话级状态，刷新页面即清空。
   */
  storageBroken: Ref<string | null>
}

/**
 * 由复制的 change 事件推算单个源内部的拉取进度（0-100 整数）。
 *
 * 可用字段（PouchDB 在每批文档写入后 emit）：
 *   - `docs_written`：本次复制累计写入的文档数；
 *   - `pending`：服务端 `_changes` 返回的剩余变更数（CouchDB 2.0+ 才带，
 *     PouchDB 只在**本批有文档写入**时才把 pending 挂到事件对象上）。
 *
 * 因此 pending 缺失时**不能**当作 0 —— 那会把进度谎报成 100%。缺 pending 时
 * 只能返回上次的值（`prev`），维持单调不回退；pending 明确为 0 才表示已经拉完。
 *
 * 不用 `last_seq` 做减法：CouchDB 3.x 的 seq 是 `"1234-abc..."` 形态的字符串
 * （切片后无法做算术），且它是远端库的全局序列号，与本次复制的起点之差没有
 * 「占总量的几分之几」的含义。
 */
export function computeReplicateProgress(
  info: { docs_written?: number, pending?: number },
  prev = 0
): number {
  const written = typeof info.docs_written === 'number' ? info.docs_written : 0
  const pending = info.pending
  let next: number
  if (pending === 0) {
    // 服务端明确表示没有剩余变更：无论已写入多少，本轮拉取已完成
    next = 100
  } else if (typeof pending === 'number' && pending > 0) {
    next = Math.round(written / (written + pending) * 100)
  } else {
    // pending 缺失（老服务端 / 本批无写入）：没有新信息，沿用上次进度
    return prev
  }
  // 严格单调：pending 是每批返回时的瞬时值，批间可能出现小幅回弹，
  // 进度条倒着走会被当成卡死或异常
  return Math.min(100, Math.max(prev, next))
}

/**
 * 单次复制的拉取批大小（PouchDB 默认 100）。
 *
 * 集中库的文档带 AVIF 附件，单篇上限 1MB；一批 100 篇在极端情况下是上百 MB 的
 * 单次事务，实测在 495MB 数据量时直接触发 QuotaExceededError 把整个库打成
 * global failure。降到 20 让写入峰值可控，代价只是每批多几个请求。
 */
const REPLICATE_BATCH_SIZE = 20

/**
 * 每批入队的订阅源数量。
 *
 * 首轮（或本地缓存重建后）可能有几百个源同时需要同步：一次性全入队意味着
 * 队列里堆着几百个任务、失败时几百条错误一次性涌出，而且 IndexedDB 压力集中在
 * 同一段时间。分批入队让「暂停 / 存储故障熔断」能在批与批之间立刻生效，
 * 剩余批次直接不再发起。
 */
const SYNC_BATCH_SIZE = 50

/** 构造共享状态（usePouchDb 与 usePouchSyncStatus 共用同一份结构） */
function createPouchState(): PouchDbState {
  return {
    entriesDb: null,
    userStateDb: null,
    entriesIndexed: false,
    syncHandles: new Map<string, PouchDB.Replication.Sync<Record<string, unknown>>>(),
    syncStatuses: reactive<Record<string, SyncStatus>>({}),
    replicateWaiting: [],
    activeReplicates: 0,
    activeReplications: new Set<ActiveReplication>(),
    paused: ref(false),
    userStateSyncPromise: null,
    dbUserId: null,
    userWatchReady: false,
    syncedDocsByFeed: reactive<Record<string, number>>({}),
    storageBroken: ref<string | null>(null)
  }
}

/**
 * 只订阅同步状态，不构造整套 PouchDB 操作闭包。
 *
 * 给侧边栏图标这类「实例多、只需要知道某个源同步完没有」的小组件用：
 *   1. 几百个菜单项若各自调 usePouchDb()，会各构造一份闭包（含库管理、复制队列等）；
 *   2. 若改由侧边栏组件读取 syncStatuses 再透传下去，侧边栏的渲染就依赖了它，
 *      任何源同步完成都会让整棵导航菜单重新 patch —— 依赖留在小组件内部才不会外溢。
 */
export function usePouchSyncStatus(): Readonly<Record<string, SyncStatus>> {
  const nuxtApp = useNuxtApp() as NuxtAppWithPouchState
  nuxtApp.$pouchDbState ??= createPouchState()
  return nuxtApp.$pouchDbState.syncStatuses
}

/** 取消全部进行中的一次性复制（暂停同步 / 切换账号时用） */
function cancelActiveReplications(state: PouchDbState) {
  // 先快照再清空：cancel() 可能同步触发复制的 error 回调，回调里会回读这个集合
  for (const item of [...state.activeReplications]) {
    item.markCancelled()
    try {
      item.task.cancel()
    } catch {
      // 任务已结束时的 cancel 可能抛错，忽略
    }
  }
  state.activeReplications.clear()
}

/**
 * 管理 PouchDB 集中库同步，提供跨源条目查询能力。
 *
 * 每个订阅源通过单向复制（replicate.from）把条目同步到本地集中库，
 * 时间线/单源/分组查询走 Mango 索引（publishedAt 倒序）一次查询。
 * 用户状态库（已读/收藏/订阅）通过 live 双向同步。
 *
 * 本地库名带当前账号 id（见 utils/localDbName）：换账号就是换一套本地库，
 * 避免上一个账号的本地数据经双向同步被推进新账号的远端库。
 */
export function usePouchDb() {
  // 代理地址里的库名由后端下发（随机库名，无法推导），见 useCouchTargets
  const { remoteUrlForId, invalidate: invalidateTargets } = useCouchTargets()
  // 订阅列表接口（含 feeds.lastNewEntryAt）：手动同步 syncNow 的增量判断依据
  const api = useApi()
  // 本地库按账号隔离，需要当前登录用户（惰性取 store：usePouchDb 也可能在异步回调里被调用）
  const currentUserId = () => useUserStore().user?.id ?? null

  // 通过 nuxtApp 单例化共享状态，避免每次组件挂载都创建新实例
  const nuxtApp = useNuxtApp() as NuxtAppWithPouchState
  nuxtApp.$pouchDbState ??= createPouchState()
  const { syncHandles, syncStatuses } = nuxtApp.$pouchDbState
  // 队列与集中库字段需通过对象引用读写（解构 number 会丢失状态）
  const pouchState = nuxtApp.$pouchDbState

  /** 迁移清理的幂等 Promise（避免并发重复执行） */
  let cleanupPromise: Promise<void> | null = null

  function ensureCleanup() {
    if (!cleanupPromise) cleanupPromise = cleanupLegacyDbs()
    return cleanupPromise
  }

  /**
   * 暂停同步（左下角指示器在「正在同步」时点击）：取消进行中的复制、清空排队任务，
   * 并阻止新的复制入队，直到用户点同步恢复。
   *
   * 只作用于「一次性复制」——即进度条统计的那部分（页面自动同步与手动同步共用同一队列）；
   * 用户状态库的 live 双向同步不动：它是已读/收藏的实时通道，暂停拉取新条目不该顺带
   * 停掉状态回写。
   *
   * 被中断的库状态归位为 idle：它们在 UI 上不再是「同步中」（顶部进度条随之消失），
   * 也不递增 version（不触发列表重查）。
   */
  function pauseSync() {
    pouchState.paused.value = true
    cancelActiveReplications(pouchState)
    // 排队未开始的任务必须回执「已取消」，否则调用方（syncNow 的 Promise.all）会一直挂着
    for (const item of pouchState.replicateWaiting.splice(0)) {
      item.resolve({ ok: false, cancelled: true })
    }
    for (const [key, status] of Object.entries(syncStatuses)) {
      if (status.status === 'syncing' || status.status === 'queued') {
        syncStatuses[key] = { ...status, status: 'idle' }
      }
    }
  }

  /** 恢复同步：清除暂停标记，之后的 syncNow / 自动同步可以正常入队 */
  function resumeSync() {
    pouchState.paused.value = false
  }

  /**
   * 切换到某个账号的本地库：关掉上一个账号的实例与同步句柄，下次访问时懒重建。
   * 不删库 —— 各账号的离线数据留着，换回来还能用。
   */
  function switchUser(uid: string | null) {
    for (const [, handle] of syncHandles.entries()) handle.cancel?.()
    syncHandles.clear()
    // 在途的一次性复制对着上一个账号的库，一并取消（否则结果会写进新账号的状态）
    cancelActiveReplications(pouchState)
    // 队列里排队的复制必须回执，否则调用方（如 syncNow 的 Promise.all）会一直挂着
    for (const item of pouchState.replicateWaiting.splice(0)) {
      item.resolve({ ok: false, error: '账号已切换，同步已取消' })
    }
    if (pouchState.entriesDb) {
      pouchState.entriesDb.close()
      pouchState.entriesDb = null
    }
    if (pouchState.userStateDb) {
      pouchState.userStateDb.close()
      pouchState.userStateDb = null
    }
    pouchState.entriesIndexed = false
    pouchState.userStateSyncPromise = null
    feedIconBlobs.clear()
    entryCoverBlobs.clear()
    for (const key of Object.keys(syncStatuses)) {
      Reflect.deleteProperty(syncStatuses, key)
    }
    for (const key of Object.keys(pouchState.syncedDocsByFeed)) {
      Reflect.deleteProperty(pouchState.syncedDocsByFeed, key)
    }
    pouchState.dbUserId = uid
    // 换账号后重新开始同步，不继承上一个账号的暂停状态；
    // 存储故障也一并清掉 —— 新账号可能对应另一套（更小的）本地库，值得重新尝试
    pouchState.paused.value = false
    pouchState.storageBroken.value = null
  }

  /** 把本地实例对齐到当前账号（会话就绪前是 null → guest 库，登录后再切到该账号的库） */
  function syncDbUser() {
    const uid = currentUserId()
    if (pouchState.dbUserId !== uid) switchUser(uid)
  }

  // 会话变化立即切换：登出后不该继续对着上一个账号的库做 live 同步
  if (!pouchState.userWatchReady) {
    pouchState.userWatchReady = true
    watch(currentUserId, (uid) => {
      if (pouchState.dbUserId !== uid) switchUser(uid)
    })
  }

  /** 获取集中条目库（惰性创建，并顺带清理历史本地库） */
  function getEntriesDb(): PouchDB.Database {
    syncDbUser()
    if (!pouchState.entriesDb) {
      pouchState.entriesDb = new PouchDB(localDbName('entries', pouchState.dbUserId))
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
   * 迁移清理（每次会话最多跑一次，幂等）：
   *   1. 删除旧的 per-feed 本地库（rssfed-feed-*）。集中库方案废弃多库结构，
   *      旧数据由集中库重新同步；
   *   2. 删除账号隔离之前那两个固定库名（rssfed-entries / rssfed-user-state）。
   *      它们可能混着多个账号的数据（固定库名 + 双向同步 = 串号），一律不复用 ——
   *      搬进当前账号的隔离库反而会把上一个账号的数据固化下来并推上远端，比丢弃更糟。
   *
   * 注意：多标签页持有旧库连接时 destroy 可能被 blocked（永不返回），因此
   * 增量记录先清、删库限时放弃——保证集中库必定全量同步一次，删库失败只是残留磁盘。
   */
  async function cleanupLegacyDbs() {
    try {
      // v2：集中库架构的迁移标记（与 per-feed 时代的 v1 区分，强制重新迁移一次）
      if (!localStorage.getItem('rssfed-central-migrated-v2')) {
        // 先清增量记录：集中库全新，必须全量同步一次（无论删库是否成功）
        try {
          localStorage.removeItem('rssfed-synced-feeds')
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
      }

      // 账号隔离前的固定库名：无条件清理（库不存在时 destroy 会报错，忽略即可）
      await Promise.race([
        Promise.all(LEGACY_LOCAL_DB_NAMES.map(name => new PouchDB(name).destroy().catch(() => {}))),
        new Promise(resolve => setTimeout(resolve, 3000))
      ])
    } catch {
      // 清理失败不影响主流程（旧库残留只是占磁盘）
    }
  }

  /**
   * 复制并发上限。
   *
   * 浏览器对同一主机的并发连接有限（约 6），订阅源很多时（OPML 批量导入可达数百个）
   * 并发复制会挤爆连接与 IndexedDB 事务。
   *
   * 从 3 降到 2 的依据：在 626 个订阅源的真实数据上采 CPU profile，主线程可归因的
   * 成本里最大一块是同步落库（IndexedDB 的 put/get/transaction/blob ≈ 300ms）。
   * 并发越高这段阻塞的峰值越尖；降并发会把总同步时长略微拉长，但主线程峰值更平缓
   * ——卡顿观感取决于峰值而非总量。
   */
  const MAX_CONCURRENT_REPLICATE = 2

  /**
   * 标记本地存储已不可用并熔断本轮同步。
   *
   * 只在第一次故障时记录原因：后续同一库上的操作会以 message 为空的 Error 立即失败，
   * 那些错误没有可读信息，堆在 UI 上只会淹没真正的原因。
   */
  function setStorageBroken(detail: string) {
    if (pouchState.storageBroken.value) return
    pouchState.storageBroken.value = detail
  }

  /** 消费复制队列：空闲时从等待队列取出任务执行 */
  function pumpReplicateQueue() {
    // 本地存储已不可用：不再发起任何复制，把排队任务就地结束
    // （否则它们会在 global failure 的库上逐个快速失败，白白刷几百条错误）
    if (pouchState.storageBroken.value) {
      for (const item of pouchState.replicateWaiting.splice(0)) {
        item.resolve({ ok: false, error: pouchState.storageBroken.value })
      }
      return
    }
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
   *  checkpoint 的 seq 会大于远端（旧 seq 残留），增量同步会误判"无新变更"。
   *  seen 是本次入队时远端该源的 lastNewEntryAt，同步成功后会连同完成时间一起
   *  写进水位表，作为下一轮增量判断的依据（见 utils/syncDecision）。 */
  function enqueueReplicate(id: string, full = false, seen?: string): Promise<ReplicateResult> {
    // 用户已暂停同步：不排队、不发请求；以「已取消」回报，调用方不该当作失败
    if (pouchState.paused.value) {
      return Promise.resolve({ ok: false, cancelled: true })
    }
    // 本地存储已熔断：不再排队（复制注定写不进去，还会刷几百条错误）
    if (pouchState.storageBroken.value) {
      return Promise.resolve({ ok: false, error: pouchState.storageBroken.value })
    }
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
    // 本次入队归属的账号：切换账号后旧任务的成败都不该记到新账号头上
    // （同步记录按账号存 localStorage，记错会让新账号以为已经同步过而跳过）
    const ownerUserId = pouchState.dbUserId
    return new Promise((resolve) => {
      pouchState.replicateWaiting.push({
        id,
        full,
        seen,
        resolve: (r) => {
          if (r.ok && pouchState.dbUserId === ownerUserId) markSynced(id, seen)
          resolve(r)
        }
      })
      pumpReplicateQueue()
    })
  }

  /**
   * 分批入队并等待每批完成。
   *
   * 首轮可能有几百个源需要同步：一次性全入队会让队列长期堆着几百个任务，
   * 且「暂停 / 存储故障」要等所有任务都轮完才生效。分批后每批 50 个，
   * 批与批之间检查暂停与熔断状态，剩余批次直接不再发起。
   *
   * 返回值与 ids 等长：被中断而未执行的批次补 `cancelled`（用户暂停）或
   * `error`（存储熔断），调用方不必处理下标缺失。
   */
  async function enqueueInBatches(
    ids: string[],
    full: boolean,
    seenOf: (id: string) => string | undefined
  ): Promise<ReplicateResult[]> {
    const results: ReplicateResult[] = []
    for (let i = 0; i < ids.length; i += SYNC_BATCH_SIZE) {
      const broken = pouchState.storageBroken.value
      if (pouchState.paused.value || broken) {
        // 未执行的批次统一按「本轮中断」上报（不是失败）：暂停由用户操作解释，
        // 存储熔断由 storageBroken 状态解释（UI 会给出专门提示），
        // 这样不会把几百条「未尝试」的源刷成失败项淹没真正的原因。
        for (let j = i; j < ids.length; j++) {
          results.push({ ok: false, cancelled: true })
        }
        break
      }
      const batch = ids.slice(i, i + SYNC_BATCH_SIZE)
      const settled = await Promise.all(batch.map(id => enqueueReplicate(id, full, seenOf(id))))
      results.push(...settled)
    }
    return results
  }

  /**
   * 对指定订阅源执行一次性单向复制（远端 per-feed CouchDB → 本地集中库），
   * 并更新同步状态。增量由 PouchDB checkpoint 保证（每源独立记录同步位置）；
   * full=true 时强制全量（since: 0），见 enqueueReplicate 说明。
   *
   * 复制归属的账号在开头固定：期间若切换账号，本地实例已被关闭、结果一律作废，
   * 也不再往新账号的同步状态里写（否则进度条会留下一条永不结束的记录）。
   *
   * 用户暂停同步（pauseSync）会 cancel 本任务，结果以 cancelled 回报：
   * 既不算失败，也不递增 version。
   */
  async function replicateDb(id: string, full = false): Promise<ReplicateResult> {
    const ownerUserId = pouchState.dbUserId
    /** 只有账号没变时才写同步状态 */
    function setStatus(status: SyncStatus) {
      if (pouchState.dbUserId === ownerUserId) syncStatuses[id] = status
    }

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

    // 用户在这期间点了暂停：这个任务已经从队列移出（pause 清空队列时取消不到它），
    // 直接放弃 —— 不发起复制，也不上报失败（暂停不是失败）
    if (pouchState.paused.value) return { ok: false, cancelled: true }

    if (!remoteUrl) {
      const error = lookupError ?? `未取到订阅对应的 CouchDB 库名（${id}），已跳过同步`
      setStatus({
        feedId: id,
        status: 'error',
        version: syncStatuses[id]?.version ?? 0,
        error
      })
      // 取不到库名也是「尝试失败」：同样进退避表，避免每轮对同一批脏订阅反复打接口
      markAttemptFailed(id)
      return { ok: false, error }
    }

    setStatus({
      feedId: id,
      status: 'syncing',
      version: syncStatuses[id]?.version ?? 0,
      // 进度从 0 起算：本轮的 change 事件会在第一批写入后把它推上去
      progress: 0
    })

    // 取消标记 + 任务句柄：用户暂停时 pauseSync 会标记并 cancel。
    // cancel 会让下面的 await 以错误 reject，光看错误分不清「暂停」与真失败，靠标记区分。
    let cancelled = false
    const entry: ActiveReplication = {
      // 占位任务：replicate.from 返回真实句柄后立即替换。暂停恰好发生在这两步之间时，
      // markCancelled 已置位，由 await 之后的兜底检查取消这个刚创建的任务
      task: { cancel: () => {} },
      markCancelled: () => {
        cancelled = true
      }
    }
    pouchState.activeReplications.add(entry)

    /**
     * 复制的 change 监听器：由 utils 的 computeReplicateProgress 推算源内进度，
     * 只推进 progress / docsWritten / pending 三个字段。
     *
     * 关键约束：**绝不在这里递增 version** —— 列表页 watch version 变化就重查条目，
     * 一批数据就重查一次会让长同步期间列表反复抖动（几秒内几十次查询）。
     * 真正需要上屏的数据变化在复制完成时由 version +1 统一触发。
     *
     * 每批都写一次响应式状态，但先比掉重复的整数值：PouchDB 的批大小是 20，
     * 一个几百条的源会 emit 十几次，值不变时不必触发组件重渲染。
     */
    /**
     * 本次复制累计写入的文档数：`docs_written` 是本次复制的累计值（不是本批增量），
     * 所以每次覆盖即可，复制成功时把它加进「已同步条数」。只有进度用途时它会被丢掉。
     */
    let replicatedDocs = 0

    const onChange = (info: { docs_written?: number, pending?: number }) => {
      // 暂停/换账号后状态已归位，迟到的 change 不该把它改回 syncing
      const current = syncStatuses[id]
      if (pouchState.dbUserId !== ownerUserId || current?.status !== 'syncing') return
      const progress = computeReplicateProgress(info, current.progress ?? 0)
      const docsWritten = info.docs_written
      if (typeof docsWritten === 'number') replicatedDocs = docsWritten
      const pending = info.pending
      if (progress === current.progress && docsWritten === current.docsWritten && pending === current.pending) {
        return
      }
      setStatus({
        feedId: id,
        status: 'syncing',
        version: current.version,
        progress,
        ...(typeof docsWritten === 'number' ? { docsWritten } : {}),
        ...(typeof pending === 'number' ? { pending } : {})
      })
    }

    try {
      // batch_size 调小：集中库文档带 AVIF 附件，默认 100 篇一批在数据量大时
      // 会把单次写入峰值顶到配额上限（见 REPLICATE_BATCH_SIZE 说明）
      const task = db.replicate.from(remoteUrl, full
        ? { since: 0, batch_size: REPLICATE_BATCH_SIZE }
        : { batch_size: REPLICATE_BATCH_SIZE })
      // Replication 的重载式 on 与本模块的简化句柄类型不兼容（见 ReplicationTaskHandle），
      // 这里按实际用到的能力断言：只 subscribe change，其余行为不变
      const handle = task as unknown as ReplicationTaskHandle
      entry.task = handle
      // on 可能不存在（测试里的假任务、极端环境下被剥掉的原型）。
      // 进度只是观感增强，拿不到就不能影响复制本身。
      if (typeof handle.on === 'function') {
        handle.on('change', onChange)
      }
      if (cancelled) {
        // 任务创建期间用户点了暂停：立刻取消，状态保持 pauseSync 归位后的 idle
        try {
          task.cancel()
        } catch {
          // 忽略：任务可能已自行结束
        }
        return { ok: false, cancelled: true }
      }
      const res = await task
      // 用户在这批数据落库期间点了暂停：cancel 会与「复制刚好完成」撞车 ——
      // PouchDB 的 cancel 只在任务未完成时以错误 reject，已经拿到结果的 task 会正常
      // resolve。此时必须按取消上报：否则 syncNow 会把「用户已经放弃的源」算成成功
      // （toast 报同步完成、水位表被往前推），而状态早已被 pauseSync 归位为 idle。
      if (cancelled) return { ok: false, cancelled: true }
      if (!res.ok) {
        throw new Error(`同步失败（HTTP ${res.status}）`)
      }
      // 先累加「已同步条数」再写状态：列表页 watch 的是 version 变化，回调执行时计数必须已是新值
      if (replicatedDocs > 0) {
        pouchState.syncedDocsByFeed[id] = (pouchState.syncedDocsByFeed[id] ?? 0) + replicatedDocs
      }
      setStatus({
        feedId: id,
        status: 'idle',
        version: (syncStatuses[id]?.version ?? 0) + 1,
        lastSyncedAt: new Date().toISOString()
        // 完成后不再带 progress/docsWritten/pending：状态是「已完成」，
        // 留着进度字段会让进度条把它当成一次进行中的复制重复计入
      })
      return { ok: true }
    } catch (e: unknown) {
      // 用户暂停导致的取消：不记失败、不写 error（状态已由 pauseSync 归位）
      if (cancelled) return { ok: false, cancelled: true }
      const message = errorMessage(e)
      // 本地存储故障（配额耗尽 / IndexedDB 崩溃）：熔断整轮同步，避免把剩余几百个
      // 任务逐个砸在同一块坏掉的库上；用户需要重置本地缓存才能真正恢复
      if (isStorageFailure(e)) {
        setStorageBroken('本地缓存写入失败（存储空间不足或数据库已损坏），已暂停本轮同步。请到「我的 → 重置本地缓存」清理后重试')
      }
      // 记入退避表：下一轮不会立刻再对这条源重试（指数退避，见 utils/syncDecision）
      markAttemptFailed(id)
      setStatus({
        feedId: id,
        status: 'error',
        version: syncStatuses[id]?.version ?? 0,
        error: message
      })
      return { ok: false, error: message }
    } finally {
      // 摘掉监听器：任务结束后 change 不会再触发，但句柄可能被外部引用（如 entry.task），
      // 留着闭包会让整轮复制的中间状态多活一份
      if (typeof entry.task.on === 'function') {
        try {
          entry.task.removeListener?.('change', onChange)
        } catch {
          // 任务可能已自行清理监听器，忽略
        }
      }
      pouchState.activeReplications.delete(entry)
    }
  }

  /**
   * 将某个订阅源加入复制队列（同步到集中库）
   */
  function syncFeed(feedId: string) {
    void enqueueReplicate(feedId)
  }

  /**
   * 增量同步的水位表：每个源「上次成功同步的时间 + 当时看到的服务端 lastNewEntryAt」，
   * 持久化在 localStorage（key 按账号隔离 —— 否则 A 的同步记录会让 B 以为自己已经
   * 同步过，直接跳过）。对比规则见 utils/syncDecision：
   * 自动同步（syncFeedsIfChanged）与手动同步（syncNow）共用同一套判断。
   *
   * 兼容 v1：旧记录是纯 ISO 字符串，读取时按时间比较处理，下次成功后写回 v2。
   */
  function loadSyncedFeeds(): SyncedMap {
    try {
      return JSON.parse(localStorage.getItem(syncedFeedsKey(pouchState.dbUserId)) ?? '{}') as SyncedMap
    } catch {
      return {}
    }
  }

  /**
   * 记录某个源本次同步成功（仅成功时）。
   *
   * `seen` 是本次入队时远端该源的 lastNewEntryAt：下一轮直接比这个服务端值，
   * 不再拿「服务端时间 vs 浏览器时间」比较（跨机器时钟偏差会误判成永远有新内容）。
   * 本次拿不到 seen（如离线降级 / full 重建）时保留旧值，避免把水位记录降级回 v1。
   */
  function markSynced(feedId: string, seen?: string) {
    try {
      const map = loadSyncedFeeds()
      const prev = normalizeMark(map[feedId])
      // 本次没拿到 seen（离线降级 / full 重建）时沿用旧值，避免把 v2 记录降级回 v1
      const seenValue = seen ?? prev?.seen
      map[feedId] = seenValue
        ? { at: new Date().toISOString(), seen: seenValue }
        : { at: new Date().toISOString() }
      localStorage.setItem(syncedFeedsKey(pouchState.dbUserId), JSON.stringify(map))
      // 成功即清退避：下次该源有新内容时立刻同步，不必等退避窗口
      clearRetryMark(feedId)
    } catch {
      // localStorage 不可用时忽略（同步本身不受影响）
    }
  }

  /** 读取失败退避表（key 按账号隔离，与水位表同规则） */
  function loadRetryMarks(): RetryMap {
    try {
      return JSON.parse(localStorage.getItem(syncRetryKey(pouchState.dbUserId)) ?? '{}') as RetryMap
    } catch {
      return {}
    }
  }

  function saveRetryMarks(map: RetryMap) {
    try {
      localStorage.setItem(syncRetryKey(pouchState.dbUserId), JSON.stringify(map))
    } catch {
      // localStorage 不可用时忽略
    }
  }

  /**
   * 记录一次失败尝试：连续失败次数 +1，下次重试时间随次数指数退避。
   *
   * 这是「每次打开都几百个源要同步」的关键修复：原先失败的源不会留下任何记录，
   * 下一轮仍被判为「从未同步过」而全量重试，形成死循环。
   */
  function markAttemptFailed(feedId: string) {
    if (feedId === USER_STATE_ID) return // 用户状态库必须同步，不进退避表
    const map = loadRetryMarks()
    const prev = map[feedId]
    map[feedId] = {
      attempts: (prev?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString()
    }
    saveRetryMarks(map)
  }

  /** 清除某个源的退避记录（同步成功后调用） */
  function clearRetryMark(feedId: string) {
    const map = loadRetryMarks()
    if (!(feedId in map)) return
    // 与 syncStatuses 同一处理：动态键用 Reflect.deleteProperty，避免破坏 V8 的对象形状优化
    Reflect.deleteProperty(map, feedId)
    saveRetryMarks(map)
  }

  /**
   * 取远端订阅列表（含 feeds.lastNewEntryAt，增量同步的判断依据）。
   * 失败（离线 / 未登录 / 接口不可达）返回 null，由调用方决定降级策略。
   */
  async function fetchRemoteSubs(): Promise<FeedSubscriptionItem[] | null> {
    try {
      return await api.feeds.subscriptions()
    } catch {
      return null
    }
  }

  async function syncFeedsIfChanged(feeds: Array<{ feedId: string, lastNewEntryAt?: string }>) {
    // 用户已暂停同步：本轮自动同步（页面挂载时的增量同步）直接跳过，点指示器可恢复
    if (pouchState.paused.value) return 0

    // 等待迁移清理完成：首次迁移时旧增量记录会导致误跳过，需清空后全量同步一次
    await ensureCleanup()

    // 水位表与退避表各只读一次：订阅源可达数百个，逐个读 localStorage + JSON.parse 是白开销
    const synced = loadSyncedFeeds()
    const retry = loadRetryMarks()
    const needSync: string[] = []
    // 本次入队时各源的 lastNewEntryAt：同步成功后写回水位表，作为下一轮的比较基准
    const seenById = new Map<string, string | undefined>()

    for (const f of feeds) {
      // 脏订阅文档（feedId 为空/缺失）无法定位远端库，跳过
      if (!isValidDbId(f.feedId)) continue
      seenById.set(f.feedId, f.lastNewEntryAt)
      if (!needsSync(f.feedId, f.lastNewEntryAt, synced, retry)) continue
      needSync.push(f.feedId)
    }

    // 分批入队且不等待全量：调用方是页面挂载流程，不能被几百个源的复制堵住首屏
    // （复制完成后的列表刷新由 syncStatuses 的 version 变化触发）
    void enqueueInBatches(needSync, false, id => seenById.get(id))
    return needSync.length
  }

  /**
   * 手动触发一次性同步：拉取「上次同步后有过新内容」的订阅源到集中库。
   *
   * 触达范围：不传 feedIds 时作用于当前全部订阅 + 用户状态库；传入时仅作用于指定源。
   * 与自动同步（syncFeedsIfChanged）共用同一套增量判断 —— 远端 feeds.lastNewEntryAt
   * 对比本地记录的同步水位（localStorage），没有变化的源连复制请求都不发，因此订阅源
   * 成百上千时点一下按钮也不会打满请求。判断依据取不到（离线 / 接口失败）时降级为
   * 不过滤，复制仍由 PouchDB checkpoint 兜底增量（等同于改动前的行为）。
   *
   * 复制本身也走 checkpoint 增量；只有 opts.full 才强制 since: 0 全量，用于本地缓存被
   * 清空后的重建（resetLocalData 已清掉水位线与 checkpoint 的场景），日常点击不要用。
   *
   * 用户状态库没有 lastNewEntryAt 概念，在目标集合里就参与同步；一次性复制前要临时
   * 暂停它的 live 双向同步（避免两条链路抢连接），复制完成后恢复实时同步。
   * 复制统一走并发受限队列（见 enqueueReplicate），订阅源很多时不会挤爆连接。
   *
   * 返回值 skipped 是被增量过滤跳过的目标数，供 UI 提示「无更新」，避免点了按钮像没反应；
   * cancelled 是本轮被用户暂停中断的目标数（不算失败，UI 不弹失败提示）；
   * added 是本轮真正写入本地的文档数（0 = 这次同步没有带来任何新条目）。
   *
   * 用户主动调用即视为「恢复同步」：暂停状态下点同步会先清掉暂停标记，否则复制会被拦在
   * 队列外（见 enqueueReplicate）。
   */
  async function syncNow(
    feedIds?: string[],
    opts: { full?: boolean } = {}
  ): Promise<SyncNowResult> {
    // 用户主动同步 = 恢复：先清掉暂停标记
    resumeSync()
    return runSyncNow(feedIds, opts)
  }

  /** syncNow 的实际逻辑（触发范围与降级规则见其上方文档注释） */
  async function runSyncNow(
    feedIds?: string[],
    opts: { full?: boolean } = {}
  ): Promise<SyncNowResult> {
    // 目标集合：显式传入的 feed，或当前已订阅的全部源 + 用户状态库。
    // 订阅列表从 user-state 库读取（syncStatuses 是会话状态，刷新后为空，不能作为依据）
    let targets: string[]
    if (feedIds?.length) {
      targets = [...new Set(feedIds)].filter(isValidDbId)
    } else {
      const subs = await listSubscriptions()
      targets = [...new Set([...subs.map(s => s.id), USER_STATE_ID])].filter(isValidDbId)
    }

    // ① 增量过滤：挑出真正有变化的源。full 模式跳过 —— 本地库要重建，所有源都得重拉
    const candidateCount = targets.length
    // 本次入队时各源的 lastNewEntryAt：同步成功后写回水位表（full 模式下拿不到，保留旧值）
    const seenById = new Map<string, string | undefined>()
    if (!opts.full) {
      const remoteSubs = await fetchRemoteSubs()
      for (const s of remoteSubs ?? []) seenById.set(s.feedId, s.lastNewEntryAt)
      targets = pickFeedsNeedingSync(targets, remoteSubs, loadSyncedFeeds(), USER_STATE_ID, loadRetryMarks())
    }

    // 全部跳过：不暂停 live 同步、不发任何复制请求（按钮瞬时完成）
    if (targets.length === 0) {
      return { ok: [], failed: [], skipped: candidateCount, cancelled: 0, added: 0 }
    }

    // ② 临时暂停用户状态库的 live 同步，释放长轮询连接给一次性复制使用。
    // 先等 live 同步启动完成：它要先取库名（异步），否则 handle 还没挂上，暂停会落空
    await pouchState.userStateSyncPromise
    const pausedUserState = syncHandles.has(USER_STATE_ID)
    if (pausedUserState) {
      syncHandles.get(USER_STATE_ID)!.cancel()
      syncHandles.delete(USER_STATE_ID)
    }

    // ③ 分批入队执行一次性复制（队列内部限制并发，批间可被暂停/熔断中断）
    // 复制前记下各目标的「已同步文档数」基线，结束后做差得到本轮真正写入的条数（见 ⑤）
    const docsBefore = new Map<string, number>()
    for (const id of targets) {
      docsBefore.set(id, pouchState.syncedDocsByFeed[id] ?? 0)
    }
    const results = await enqueueInBatches(targets, opts.full === true, id => seenById.get(id))
    const ok: string[] = []
    const failed: { id: string, error: string }[] = []
    const cancelled: string[] = []
    targets.forEach((id, i) => {
      const r = results[i]!
      if (r.cancelled) {
        // 用户暂停导致的中断：既不算成功也不算失败
        cancelled.push(id)
      } else if (r.ok) {
        ok.push(id)
      } else {
        failed.push({ id, error: r.error ?? '未知错误' })
      }
    })

    // ④ 恢复用户状态库的 live 同步，保持已读/收藏的实时双向同步
    if (pausedUserState) {
      void startUserStateLiveSync()
    }

    // ⑤ 本轮真正写入本地的文档数。只看本轮目标：别的源（后台自动同步）并发写入不会算进来。
    //    被熔断/重置本地缓存时计数可能变小，用 Math.max 兜底为 0，不报负数。
    let added = 0
    for (const id of targets) {
      added += Math.max(0, (pouchState.syncedDocsByFeed[id] ?? 0) - (docsBefore.get(id) ?? 0))
    }

    return { ok, failed, skipped: candidateCount - targets.length, cancelled: cancelled.length, added }
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
   * 读取用户在订阅列表里自定义的源名（用户状态库 `subscription:{feedId}` 文档的 title）。
   * 侧边栏展示的正是这个名字，条目上的源名必须与之一致；没订阅过或没改过名时没有对应项，
   * 调用方回退注册表抓来的标题。按 keys 精确取，只读当前页涉及的源。
   */
  async function loadSubscriptionTitles(feedIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    if (feedIds.length === 0) return titles
    try {
      const res = await getUserStateDb().allDocs({
        include_docs: true,
        keys: feedIds.map(id => `subscription:${id}`)
      })
      for (const row of res.rows as Array<{ doc?: StateDoc }>) {
        const doc = row.doc
        if (doc?.type === 'subscription' && doc.feedId && doc.title) {
          titles.set(doc.feedId, doc.title)
        }
      }
    } catch {
      // 状态库尚未就绪/读取失败：不阻塞条目渲染，源名回退注册表标题
    }
    return titles
  }

  /**
   * 取某个源在用户订阅列表里的自定义名字（离线可用）。
   * 单源页/dashboard 顶栏优先显示它，注册表抓来的原始标题只作兜底；
   * 没订阅过或没改过名时返回 null。
   */
  async function getSubscriptionTitle(feedId: string): Promise<string | null> {
    const titles = await loadSubscriptionTitles([feedId])
    return titles.get(feedId) ?? null
  }

  /**
   * 合并条目的已读 / 收藏状态。
   *
   * 条目本体在集中库、用户状态在另一个库（`entry-state:{entryId}`），列表要显示已读态就得单独取一次。
   * 只按**当前窗口**的 id 批量 allDocs（页大小几十条），不扫全库；取不到就当作未读，
   * 列表照常渲染 —— 已读态是锦上添花，不该因为用户状态库没就绪而让列表空掉。
   */
  async function attachReadState(entries: RssEntry[]): Promise<void> {
    if (entries.length === 0) return
    try {
      const res = await getUserStateDb().allDocs({
        include_docs: true,
        keys: entries.map(e => `entry-state:${e.id}`)
      })
      const byEntry = new Map<string, StateDoc>()
      for (const row of res.rows as Array<{ doc?: StateDoc }>) {
        if (row.doc?.type === 'entry-state' && row.doc.entryId) byEntry.set(row.doc.entryId, row.doc)
      }
      for (const entry of entries) {
        const state = byEntry.get(entry.id)
        if (!state) continue
        entry.read = state.read === true
        entry.starred = state.saved === true
      }
    } catch {
      // 用户状态库不可用：保持未读，不影响列表
    }
  }

  /**
   * 批量标记已读 / 未读（列表页「全部标记为已读」用）。
   *
   * 先按 id 取一次现有 entry-state 拿 `_rev`（没有的补建、已经是目标状态的跳过），再一次性
   * bulkDocs 落盘：避免逐条 get+put 的 N 次往返，也不会把已读过的条目重复写一遍同步出去。
   * 返回真正写入的条数（0 = 这批本来就都是目标状态）。
   */
  async function markManyRead(
    entries: Array<Pick<RssEntry, 'id' | 'feedId'>>,
    read = true
  ): Promise<number> {
    if (entries.length === 0) return 0
    const stateDb = getUserStateDb()
    const now = new Date().toISOString()
    const existing = new Map<string, StateDoc>()
    try {
      const res = await stateDb.allDocs({
        include_docs: true,
        keys: entries.map(e => `entry-state:${e.id}`)
      })
      for (const row of res.rows as Array<{ doc?: StateDoc }>) {
        if (row.doc?.type === 'entry-state' && row.doc.entryId) existing.set(row.doc.entryId, row.doc)
      }
    } catch {
      // 取不到就当全都没有状态文档，下面按新建处理（put 冲突会在结果里体现）
    }
    const writes = entries
      .filter(e => (existing.get(e.id)?.read === true) !== read)
      .map((e) => {
        const prev = existing.get(e.id)
        return prev
          ? { ...prev, read, readAt: read ? now : undefined }
          : {
              _id: `entry-state:${e.id}`,
              type: 'entry-state',
              entryId: e.id,
              feedId: e.feedId,
              read,
              readAt: read ? now : undefined,
              saved: false
            }
      })
    if (writes.length === 0) return 0
    const results = await stateDb.bulkDocs(writes)
    // 个别冲突（同一条在别处刚被改过）不算整体失败，只记未写入
    const written = results.filter(r => !('error' in r && r.error)).length
    return written
  }

  /**
   * 收藏列表：状态在用户状态库、条目本体在集中库，map view 没法 join，只能分两步查。
   *
   * 窗口按**收藏时间**切（savedAt 倒序），分块回查窗口内的条目。窗口只在「本地真的存在」
   * 的条目上计数：状态文档可能指向本机还没有的条目（别的设备刚收藏、条目还没同步过来），
   * 那种 id 直接跳过，否则一页可能全是查不到的 id、收藏夹看起来是空的。
   */
  async function querySavedEntries(limit = 50): Promise<RssEntry[]> {
    let states: StateDoc[] = []
    try {
      const res = await getUserStateDb().allDocs({
        include_docs: true,
        startkey: 'entry-state:',
        endkey: 'entry-state:\uffff'
      })
      states = (res.rows as Array<{ doc?: StateDoc }>)
        .map(row => row.doc)
        .filter((doc): doc is StateDoc =>
          doc?.type === 'entry-state' && doc.saved === true && Boolean(doc.entryId))
    } catch {
      // 状态库不可用：当空列表，页面给空态
      return []
    }
    if (states.length === 0) return []

    // 收藏时间倒序；老文档可能没写 savedAt，用空串参与字典序比较，自然排在最后
    states.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))
    const stateIds = states.map(state => state.entryId).filter((id): id is string => Boolean(id))

    // 分块回查：一次 allDocs 带全部 keys 会让请求体随收藏数线性增长
    const CHUNK_SIZE = 200
    const entries: RssEntry[] = []
    for (let i = 0; i < stateIds.length && entries.length < limit; i += CHUNK_SIZE) {
      const chunk = stateIds.slice(i, i + CHUNK_SIZE)
      let docs: EntryDoc[] = []
      try {
        const res = await getEntriesDb().allDocs({ include_docs: true, keys: chunk })
        docs = (res.rows as Array<{ doc?: EntryDoc }>)
          .map(row => row.doc)
          .filter((doc): doc is EntryDoc => Boolean(doc))
      } catch {
        // 条目库不可用：返回已经拿到的部分，页面照常展示
        break
      }
      const byId = new Map(docs.map(doc => [doc._id, doc]))
      // 按 chunk（= 收藏时间顺序）逐个收，不能按 allDocs 的返回顺序重排
      for (const id of chunk) {
        const doc = byId.get(id)
        if (!doc) continue
        entries.push(docToEntry(doc))
        if (entries.length >= limit) break
      }
    }

    // 已读/收藏状态与源元信息由 enrichEntries 统一补全（attachReadState 会再合一次 read/starred）
    return enrichEntries(entries)
  }

  /**
   * 补全条目的 feed 元信息（源名/站点/图标）与封面图 blob。
   * FeedDoc 随库同步到集中库（replicate 无 filter），一次 allDocs 读取全部所需文档；
   * 图标优先本地缓存的 AVIF 附件（blob URL），离线可用；无缓存回退原始 URL。
   * 源名以用户自定义的订阅名（见 loadSubscriptionTitles）优先，注册表标题仅作兜底，
   * 保证与侧边栏显示的名字一致（自定义名可覆盖抓取到的原始标题）。
   */
  async function enrichEntries(entries: RssEntry[]): Promise<RssEntry[]> {
    if (entries.length === 0) return entries
    // 先合已读状态：它来自用户状态库，与下面的 feed 元信息互不依赖
    await attachReadState(entries)
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
    // 用户自定义订阅名：优先于注册表抓来的标题（与侧边栏一致）
    const subscriptionTitles = await loadSubscriptionTitles(feedIds)
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
      if (doc) {
        entry.feed = {
          id: doc._id,
          title: doc.title ?? '',
          siteUrl: doc.siteUrl ?? '',
          feedUrl: doc.url ?? '',
          image: (await resolveFeedImage(doc)) ?? undefined,
          lastFetchedAt: doc.lastFetchedAt ?? ''
        }
      }
      // 自定义名覆盖注册表标题；bot 订阅没有 FeedDoc，也能靠这里拿到侧边栏里的名字
      const customTitle = subscriptionTitles.get(entry.feedId)
      if (customTitle) {
        entry.feed = { ...entry.feed, id: entry.feedId, title: customTitle }
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
      localStorage.removeItem(syncedFeedsKey(pouchState.dbUserId))
      // 失败退避记录一并清掉：库已重建，之前的失败（很可能就是存储故障本身）不再适用
      localStorage.removeItem(syncRetryKey(pouchState.dbUserId))
    } catch {
      // localStorage 不可用时忽略
    }
    // 存储故障已通过重建本地库解除：清掉熔断标记，让后续同步可以继续
    pouchState.storageBroken.value = null
    // 同步状态重置为未同步（relatedIds 依赖它判断全量同步目标）
    // 用 Reflect.deleteProperty 而不是 delete：后者对动态键会破坏 V8 的对象形状优化
    for (const key of Object.keys(syncStatuses)) {
      Reflect.deleteProperty(syncStatuses, key)
    }
    for (const key of Object.keys(pouchState.syncedDocsByFeed)) {
      Reflect.deleteProperty(pouchState.syncedDocsByFeed, key)
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
    syncDbUser()
    if (!pouchState.userStateDb) {
      pouchState.userStateDb = new PouchDB(localDbName('user-state', pouchState.dbUserId))
      // 记下启动 Promise：syncNow 要等它挂上 handle 才能暂停 live 同步
      pouchState.userStateSyncPromise = startUserStateLiveSync()
    }
    return pouchState.userStateDb
  }

  /**
   * 读改写一条 entry-state（已读与收藏共用同一个文档，只能整文档回写）。
   *
   * `mutate` 收到**最新一版**文档（不存在时为 null），返回要合并进去的字段；写冲突
   * （409：同一账号的另一台设备 / 另一个标签页刚改过）时重读再重算，最多 3 轮。
   *
   * 不用「get 失败就当文档不存在、直接 put 新建」的旧写法：get 也可能因为冲突以外的
   * 原因（网络、库还没就绪）失败，那种情况下新建会把对端刚写入的收藏位冲掉。
   */
  async function mutateEntryState(
    entryId: string,
    feedId: string,
    mutate: (prev: StateDoc | null) => Partial<StateDoc>
  ): Promise<StateDoc> {
    const stateDb = getUserStateDb()
    const docId = `entry-state:${entryId}`
    const maxAttempts = 3

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let prev: StateDoc | null = null
      try {
        prev = await stateDb.get(docId) as unknown as StateDoc
      } catch (e: unknown) {
        // 404 = 还没有这条状态文档，下面按新建处理；其它错误照抛给调用方
        if ((e as { status?: number }).status !== 404) throw e
      }

      const patch = mutate(prev)
      const next: StateDoc = prev
        ? { ...prev, ...patch }
        : {
            _id: docId,
            type: 'entry-state',
            entryId,
            feedId,
            // 新建时两个开关都给默认值，避免出现「只有 read 没有 saved」的半条状态
            read: false,
            saved: false,
            ...patch
          }

      try {
        const res = await stateDb.put(next)
        return { ...next, _rev: res.rev }
      } catch (e: unknown) {
        // 冲突时本轮的 prev 已过期，重读一版重算；最后一轮仍冲突就抛给调用方
        if ((e as { status?: number }).status !== 409 || attempt === maxAttempts - 1) throw e
      }
    }
    // 循环只可能以 return / throw 结束，这行只为类型收窄
    throw new Error(`写入条目状态失败：${entryId}`)
  }

  /**
   * 标记单条条目为已读 / 未读。
   * 只碰 read / readAt，收藏位原样保留（两者同文档）。
   */
  async function markRead(entryId: string, feedId: string, read: boolean): Promise<void> {
    await mutateEntryState(entryId, feedId, () => (
      read
        ? { read: true, readAt: new Date().toISOString() }
        // undefined 在序列化时会被丢掉，等于把 readAt 一并清掉
        : { read: false, readAt: undefined }
    ))
  }

  /**
   * 收藏 / 取消收藏条目，返回切换后的状态（调用方据此就地更新界面）。
   */
  async function toggleSaved(entryId: string, feedId: string): Promise<boolean> {
    let saved = false
    await mutateEntryState(entryId, feedId, (prev) => {
      saved = !(prev?.saved === true)
      return saved
        ? { saved: true, savedAt: new Date().toISOString() }
        : { saved: false, savedAt: undefined }
    })
    return saved
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
        kind: doc.kind === 'bot' ? 'bot' as const : 'feed' as const,
        view: isListView(doc.view) ? doc.view : undefined
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
   * 更新订阅元信息（显示名 / 分类 / 默认视图）。
   *
   * view 传 null 表示「清除该订阅源的默认视图」（页面回退到分组 / 全局默认），
   * 与 undefined（不动这个字段）是两种语义，所以不能用可选字段省略表达。
   */
  async function updateSubscription(
    feedId: string,
    patch: { title?: string, category?: string, view?: ListView | null }
  ) {
    const stateDb = getUserStateDb()
    const docId = `subscription:${feedId}`
    const doc = await stateDb.get(docId) as unknown as StateDoc
    const next: StateDoc = {
      ...doc,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {})
    }
    if (patch.view !== undefined) {
      if (patch.view === null) Reflect.deleteProperty(next, 'view')
      else next.view = patch.view
    }
    await stateDb.put(next)
  }

  // ── 分组（文件夹）默认视图 ──
  //
  // 分组不是独立实体：它就是订阅文档上的自由文本 category（见 useFeedNavigation 的分组规则），
  // 所以分组偏好单独存一条用户状态库文档，与订阅一起双向同步、跟着账号走。

  const GROUP_PREF_PREFIX = 'pref:group:'

  /** 分组偏好文档的 _id */
  function groupPrefId(name: string): string {
    return `${GROUP_PREF_PREFIX}${name}`
  }

  /**
   * 读取某个订阅源自身的默认视图与所属分组。
   *
   * 单源页用它解析默认视图（订阅源 -> 分组 -> 全局，见 composables/useListView）。
   * 文档缺失（离线、别的设备删了订阅）时返回全空，调用方按「未配置」处理。
   */
  async function getSubscriptionViewPrefs(
    feedId: string
  ): Promise<{ view: ListView | null, category: string | null }> {
    try {
      const doc = await getUserStateDb().get(`subscription:${feedId}`) as unknown as StateDoc
      return {
        view: isListView(doc.view) ? doc.view : null,
        category: doc.category?.trim() || null
      }
    } catch {
      return { view: null, category: null }
    }
  }

  /** 读取某个分组的默认视图（未配置返回 null） */
  async function getGroupView(name: string): Promise<ListView | null> {
    if (!name) return null
    try {
      const doc = await getUserStateDb().get(groupPrefId(name)) as unknown as StateDoc
      return isListView(doc.view) ? doc.view : null
    } catch {
      return null
    }
  }

  /**
   * 批量读取全部分组默认视图（订阅管理页一次拿全，避免每个分组行各查一次）。
   *
   * 已知取舍：分组改名后偏好会留在旧名字下成为孤儿，不做自动跟随——category 是自由文本，
   * 无法判断一次修改是「分组改名」还是「这条订阅换了个组」。
   */
  async function listGroupViews(): Promise<Record<string, ListView>> {
    const out: Record<string, ListView> = {}
    try {
      const res = await getUserStateDb().allDocs({
        include_docs: true,
        startkey: GROUP_PREF_PREFIX,
        endkey: `${GROUP_PREF_PREFIX}\uffff`
      })
      for (const row of res.rows as Array<{ doc?: StateDoc }>) {
        const doc = row.doc
        if (doc?.type === 'group-pref' && doc.name && isListView(doc.view)) {
          out[doc.name] = doc.view
        }
      }
    } catch {
      // 读取失败按「未配置」处理
    }
    return out
  }

  /** 写入 / 清除某个分组的默认视图（null = 清除，回退到全局默认） */
  async function setGroupView(name: string, view: ListView | null) {
    if (!name) return
    const db = getUserStateDb()
    const docId = groupPrefId(name)
    let existing: (StateDoc & { _rev: string }) | null = null
    try {
      existing = await db.get(docId) as unknown as StateDoc & { _rev: string }
    } catch {
      // 还没有偏好文档，下面新建
    }
    if (view === null) {
      if (existing) await db.remove(existing)
      return
    }
    await db.put(existing ? { ...existing, view } : { _id: docId, type: 'group-pref', name, view })
  }

  return {
    syncFeed,
    syncFeedsIfChanged,
    syncNow,
    /**
     * 各订阅源累计同步写入的文档数（响应式，只增不减）。
     * 列表页据此显示「已同步 N 条」提示条。
     */
    syncedDocsByFeed: pouchState.syncedDocsByFeed,
    /** 暂停同步（左下角指示器在同步中点击） */
    pauseSync,
    /** 恢复同步（暂停后点击指示器，或调用 syncNow） */
    resumeSync,
    /** 是否处于用户暂停状态（响应式，供指示器显示「已暂停」） */
    paused: pouchState.paused,
    /**
     * 本地存储故障说明（非 null 表示本轮同步已熔断，需重置本地缓存）。
     * 供进度条 / 状态指示器展示与手动同步提示。
     */
    storageBroken: pouchState.storageBroken,
    queryTimeline,
    queryFeedEntries,
    queryGroupEntries,
    querySavedEntries,
    getEntry,
    getEntryAttachment,
    getFeedImageUrl,
    resetLocalData,
    getUserStateDb,
    markRead,
    markManyRead,
    toggleSaved,
    syncStatuses: syncStatuses as Readonly<Record<string, SyncStatus>>,
    listSubscriptions,
    getSubscriptionTitle,
    addSubscription,
    addBotSubscription,
    removeSubscription,
    updateSubscription,
    getSubscriptionViewPrefs,
    getGroupView,
    listGroupViews,
    setGroupView
  }
}
