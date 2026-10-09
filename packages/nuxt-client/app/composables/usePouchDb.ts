import PouchDB from 'pouchdb'
import * as PouchDBFindNS from 'pouchdb-find'
import { computed, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { RssCachedImage, RssEntry, SubscriptionItem } from '~/types/rss'
import { useCouchTargets, TIMELINE_ID, USER_STATE_ID } from '~/composables/useCouchTargets'
import { useApi, type TimelineRefreshResult } from '~/composables/useApi'
import { useUserStore } from '~/stores/user'
import { errorMessage } from '~/utils/errorMessage'
import { isStorageFailure } from '~/utils/storageFailure'
import {
  localDbName,
  lastTimelineRefreshKey,
  LEGACY_LOCAL_DB_NAMES,
  isLegacyLocalDbName,
  isLegacyLocalStorageKey,
  stripPouchNamePrefix
} from '~/utils/localDbName'
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
   * 该库内部的拉取进度（0-100，整数）。
   *
   * 来自复制任务的 `change` 事件：`docs_written` 是已写入数，
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
 * 手动同步（syncNow）的结果。
 *
 * ok / failed 是逐同步目标的结果（现在只有时间线库一个目标，见 useCouchTargets），
 * skipped 表示「服务端本轮没有新内容 / 聚合仍在后台进行」。
 *
 * added 是本轮新增的条目数（服务端写入派生库的条数，与本地实际收到的条数取较大值）。
 * 它是「这次同步有没有带来新内容」的唯一判据：为 0 时列表页可以放心把攒着的新条目上屏
 * （同步什么都没带来，不会把用户正在读的内容推走）。
 */
export interface SyncNowResult {
  ok: string[]
  failed: Array<{ id: string, error: string }>
  skipped: number
  added: number
  /** 服务端是否在本轮请求内跑完了聚合（false = 还在后台跑，结果随后由 live 复制到达） */
  serverPending: boolean
}

/**
 * 「优先同步当前列表」的结果（见 syncPriority）。
 *
 * done=false 表示等待超时：复制没有取消，仍在后台继续。页面这时用本地缓存渲染，
 * 之后拉到的条目照旧走「已同步 N 条」提示条，不会丢。
 */
export interface PrioritySyncResult {
  /** 是否等到了新内容落库（false = 超时，仍在后台跑） */
  done: boolean
  /** 本轮真正写入本地的文档数 */
  added: number
  /** 催促是否没能发出（离线/未登录），0 表示服务端已被催 */
  skipped: number
}

/**
 * 复制任务的句柄中本模块用到的部分（live 单向复制与双向 sync 都是这个形状）。
 *
 * 除 cancel 外还要 on / removeListener：进度与同步状态机来自复制的 change / paused / error 事件。
 *
 * 这里**故意不直接用 PouchDB 的 Replication 类型**：它的 `on` 是按事件名重载的，
 * 与本模块只关心几个事件的简化签名不兼容，直接约束会在赋值处报错
 * （见 ensureTimelineLiveSync 里的显式断言）。
 */
type ReplicationEvent = 'change' | 'paused' | 'active' | 'error' | 'complete' | 'denied'

interface ReplicationTaskHandle {
  cancel: () => void
  on?: (event: ReplicationEvent, listener: (arg: unknown) => void) => unknown
  removeListener?: (event: ReplicationEvent, listener: (arg: unknown) => void) => unknown
}

/**
 * 订阅 id 能否定位到源库：feedId 不能为空串，bot 订阅还需要 botId。
 *
 * 只用于过滤用户状态库里可能存在的脏订阅文档（订阅列表要显示它；至于「这个源在服务端
 * 能不能聚合」由服务端自己判断）。
 */
function isValidDbId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false
  if (id.startsWith('bot:')) return id.length > 'bot:'.length
  return true
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

/**
 * 视图扫描游标：下一批从哪一行往下读（对应视图 key 的尾部 `[发布时间(ms), _id]`）。
 *
 * 游标是**排他上界**的替代：给定 [ms, id] 时查询用 `startkey=[ms, id]`（含）往下走，
 * 因此调用方拿到 cursor 后直接传回来就能续扫，不会重复也不会漏。
 */
export interface ScanCursor {
  ms: number
  id: string
}

/** 分组扫描游标：分组视图是多个 per-feed 桶的归并，每个源各记一个位置 */
export interface GroupScanCursor {
  byFeed: Record<string, ScanCursor>
}

/** 一页扫描结果：投影行（已合已读态，未 enrich）+ 续扫游标 + 是否已扫到底 */
export interface ScanPage<C = ScanCursor> {
  rows: RssEntry[]
  cursor: C
  exhausted: boolean
}

/** nuxtApp 上挂载的 PouchDB 共享状态（用 $ 前缀避免与 Nuxt 内部字段冲突） */
type NuxtAppWithPouchState = ReturnType<typeof useNuxtApp> & { $pouchDbState?: PouchDbState }

/**
 * PouchDB 共享状态：通过 nuxtApp 单例化，确保所有组件使用同一份实例与同步状态。
 *
 * 服务端聚合架构：所有订阅源的条目由服务端聚合进用户自己的时间线库
 * （`user-timeline_*`），浏览器把它**单向 live 复制**到一个本地库（rssfed-timeline-<uid>），
 * 时间线只需一次索引查询（publishedAt 倒序）。已读/收藏/订阅仍在独立库（live 双向同步）。
 */
interface PouchDbState {
  /** 本地时间线库（服务端聚合结果的单向 live 复制目标） */
  entriesDb: PouchDB.Database | null
  /** 用户状态库（已读/收藏/订阅，live 双向同步） */
  userStateDb: PouchDB.Database | null
  /** 本地条目视图是否已安装（避免每次重复 put 设计文档） */
  entriesIndexed: boolean
  /** 同步句柄集合（时间线库单向 live 复制 / 用户状态库双向 live 同步） */
  syncHandles: Map<string, ReplicationTaskHandle>
  /** 同步状态（响应式，供组件 watch） */
  syncStatuses: Record<string, SyncStatus>
  /**
   * 正在进行的「挂上时间线 live 复制」流程（并发调用复用同一个）。
   *
   * 放在共享状态里而不是闭包变量：usePouchDb 会被多个组件各构造一份闭包，
   * 用闭包变量挡不住「两个组件同时首次取库」的情况 —— 那会挂上两条 live 复制写同一个库。
   */
  timelineSyncPromise: Promise<void> | null
  /**
   * live 复制「代次」：每次挂载 / 停用都 +1。
   *
   * 复制的 change / paused / error 回调只认自己那一代，代次一变就整批作废 ——
   * 暂停、换账号、重置本地缓存之后迟到的回调不该再改同步状态（那会让 UI 卡在「同步中」，
   * 或把一个已取消的句柄的写入数记进新库的账上）。
   */
  timelineSyncGeneration: number
  /** 用户暂停同步（左下角指示器点击暂停）：暂停期间停掉时间线 live 复制 */
  paused: Ref<boolean>
  /** 用户状态库 live 同步的启动 Promise（syncNow 暂停它之前必须先等它挂上 handle） */
  userStateSyncPromise: Promise<void> | null
  /** 当前本地实例所属的账号 id：本地库按账号隔离，见 switchUser */
  dbUserId: string | null
  /** 账号切换监听是否已注册（多个组件都会调用 usePouchDb，只需注册一次） */
  userWatchReady: boolean
  /**
   * 各同步目标「本次会话累计写入的文档数」（只增不减）。
   *
   * 数字来自 live 复制的 change 事件（`docs_written`，见 ensureTimelineLiveSync）。
   * 条目列表页据此显示「已同步 N 条」：同步只负责拉数据并报数，列表什么时候换成最新
   * 由用户点提示条决定（见 composables/useSyncedEntryList）。
   *
   * 时间线是唯一目标，所以计数是**全库**口径而不是按源口径：任何源的新条目都会让它上涨，
   * 提示条显示的是「本地时间线里多了 N 条还没看」。
   */
  syncedDocsByTarget: Record<string, number>
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
 * 「优先同步当前列表」的等待上限（毫秒）。
 *
 * **只有本地没缓存时才用得上这个上限**（有缓存先上屏，一个请求都不等，见 useListFirstPaint）：
 * 列表空着的时候等一下比闪一个「暂无条目」强，但也不能无限等。取 5s 是因为它必须是**感知得到
 * 的上限**——用户点进一个列表，超过这个时长还空着比看到旧内容更糟；而复制并没有被取消，
 * 数据随后就到（`done=false` 如实上报）。
 */
const PRIORITY_SYNC_WAIT_MS = 5000

/**
 * 删除历史遗留的本地库（迁移一次性动作）。
 *
 * 优先用 **IndexedDB 原生 API**：`indexedDB.databases()` 给出的就是实际库名，删的时候不需要任何
 * 名字映射。走 PouchDB 会踩到一层映射：`allDbs()` 返回带 `_pouch_` 前缀的实际名，而 `destroy(name)`
 * 又会自己再加一次前缀 —— 早期版本直接拿「逻辑名前缀」去匹配实际名，结果一个旧库都删不掉
 * （实测 `_pouch_rssfed-entries-<userId>` 升级后一直留着，白占几百 MB）。
 *
 * `indexedDB.databases()` 目前只有 Chromium 系支持，其它浏览器回退到 PouchDB 路径（名字剥前缀）。
 * `onblocked`（还有别的标签页开着旧库）时放弃这一个，不拖住整轮清理。
 */
async function destroyLegacyLocalDbs(): Promise<void> {
  const idb = globalThis.indexedDB as (IDBFactory & { databases?: () => Promise<{ name?: string }[]> }) | undefined
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000))
  try {
    if (idb && typeof idb.databases === 'function') {
      const names = (await idb.databases()).map(db => db.name).filter((name): name is string => !!name)
      const legacy = names.filter(isLegacyLocalDbName)
      await Promise.race([
        Promise.all(legacy.map(name => new Promise<void>((resolve) => {
          const req = idb.deleteDatabase(name)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        }))),
        timeout
      ])
      return
    }
    // 回退：PouchDB 的静态方法（allDbs / destroy）不在类型定义里，按实际签名断言
    const pouchStatic = PouchDB as unknown as {
      allDbs: () => Promise<string[]>
      destroy: (name: string) => Promise<void>
    }
    const dbs: string[] = await pouchStatic.allDbs()
    const legacy = dbs.filter(isLegacyLocalDbName)
    await Promise.race([
      Promise.all(legacy.map(name => pouchStatic.destroy(stripPouchNamePrefix(name)).catch(() => {}))),
      timeout
    ])
  } catch {
    // 删库失败不影响主流程（旧库残留只是占磁盘）
  }
}

/** 构造共享状态（usePouchDb 与 usePouchSyncStatus 共用同一份结构） */
function createPouchState(): PouchDbState {
  return {
    entriesDb: null,
    userStateDb: null,
    entriesIndexed: false,
    syncHandles: new Map<string, ReplicationTaskHandle>(),
    syncStatuses: reactive<Record<string, SyncStatus>>({}),
    timelineSyncPromise: null,
    timelineSyncGeneration: 0,
    paused: ref(false),
    userStateSyncPromise: null,
    dbUserId: null,
    userWatchReady: false,
    syncedDocsByTarget: reactive<Record<string, number>>({}),
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

/**
 * 管理 PouchDB 本地库与同步，提供条目/订阅查询能力。
 *
 * 条目由**服务端**按用户聚合进 `user-timeline_xxx` 派生库，客户端只用一条 live 单向复制
 * （replicate.from）把它拉到本地，时间线/单源/分组查询都在这一个本地库里做（map view 倒序）。
 * 用户状态库（已读/收藏/订阅）仍然 live 双向同步：它是用户自己的写入口。
 *
 * 于是「订阅源数量」不再影响同步开销 —— 拉的是一个库，不是 N 个库。
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
   * 暂停同步（左下角指示器在「正在同步」时点击）：停掉时间线库的 live 复制，
   * 并阻止新的复制/催促发起，直到用户点同步恢复。
   *
   * 只作用于「拉取服务端聚合结果」这条线；用户状态库的 live 双向同步不动：
   * 它是已读/收藏的实时通道，暂停拉取新条目不该顺带停掉状态回写。
   *
   * 被中断的库状态归位为 idle：UI 上不再是「同步中」（顶部进度条随之消失），
   * 也不递增 version（不触发列表重查）。
   */
  function pauseSync() {
    pouchState.paused.value = true
    stopTimelineLiveSync()
    const status = syncStatuses[TIMELINE_ID]
    if (status && (status.status === 'syncing' || status.status === 'queued')) {
      syncStatuses[TIMELINE_ID] = { ...status, status: 'idle' }
    }
  }

  /** 恢复同步：清除暂停标记、重新挂上 live 复制（syncNow 也会调用它） */
  function resumeSync() {
    pouchState.paused.value = false
    // 暂停期间攒下的变化要尽快拿到：清掉催促节流，让恢复后的第一次催立即发出去
    saveLastRefreshAt(0)
    void ensureTimelineLiveSync()
  }

  /**
   * 切换到某个账号的本地库：关掉上一个账号的实例与同步句柄，下次访问时懒重建。
   * 不删库 —— 各账号的离线数据留着，换回来还能用。
   */
  function switchUser(uid: string | null) {
    // live 复制的句柄都挂在 syncHandles 上：cancel 之后它们不会再往（已关闭的）旧库写
    for (const [, handle] of syncHandles.entries()) {
      try {
        handle.cancel?.()
      } catch {
        // 任务可能已自行结束
      }
    }
    syncHandles.clear()
    pouchState.timelineSyncPromise = null
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
    for (const key of Object.keys(pouchState.syncedDocsByTarget)) {
      Reflect.deleteProperty(pouchState.syncedDocsByTarget, key)
    }
    pouchState.dbUserId = uid
    // 换账号后重新开始同步，不继承上一个账号的暂停状态；
    // 存储故障也一并清掉 —— 新账号可能对应另一套（更小的）本地库，值得重新尝试
    pouchState.paused.value = false
    pouchState.storageBroken.value = null
    // 「上次催促时间」按账号存：新账号的节流窗口要从它自己的记录起算（loadLastRefreshAt 会读）
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

  /**
   * 打开（或复用）本地时间线库实例。
   *
   * 与 getEntriesDb 分开是为了避开递归：ensureTimelineLiveSync 要用库实例去挂复制，
   * 而 getEntriesDb 又要确保 live 复制在跑。这里只做「拿到实例」这一件事。
   */
  function openEntriesDb(): PouchDB.Database {
    syncDbUser()
    if (!pouchState.entriesDb) {
      pouchState.entriesDb = new PouchDB(localDbName('timeline', pouchState.dbUserId))
    }
    return pouchState.entriesDb
  }

  /** 获取本地时间线库（惰性创建，顺带清理历史本地库并确保 live 复制在跑） */
  function getEntriesDb(): PouchDB.Database {
    const db = openEntriesDb()
    void ensureCleanup()
    // 任何一次「拿到条目库」的时刻都该确保 live 复制已挂上：查询方不必各自记得先起同步
    void ensureTimelineLiveSync()
    return db
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
   * 迁移清理（每次会话最多跑一次，幂等）：删掉所有旧时代的本地库。
   *
   * 要清的是两类：
   *   1. per-feed 多库时代（rssfed-feed-*）与集中条目库时代（rssfed-entries[-uid]）——
   *      它们的结构与新版时间线库不兼容（条目附件现在是按**用户**参数压的），
   *      数据都能从服务端重新拉，所以一律丢弃而不是迁移；
   *   2. 账号隔离之前的固定库名（rssfed-entries / rssfed-user-state）——它们可能混着
   *      多个账号的数据（固定库名 + 双向同步 = 串号），搬进当前账号的隔离库会把上一个
   *      账号的数据固化下来并推上远端，比丢弃更糟。
   *
   * 注意：多标签页持有旧库连接时 destroy 可能被 blocked（永不返回），因此删库限时放弃 ——
   * 删不掉只是残留磁盘，新的时间线库照样从零同步。
   */
  async function cleanupLegacyDbs() {
    try {
      // v4：服务端聚合架构的迁移标记（与 v1 per-feed / v2 集中库区分，各迁移一次）。
      // 为什么是 v4 而不是 v3：v3 那版按前缀匹配 `allDbs()` 的实际库名（带 `_pouch_` 前缀），
      // 一个都没删掉，凡是已经打过 v3 标记的浏览器就再也不会清理旧条目库了 —— 必须换新标记重跑一次。
      if (!localStorage.getItem('rssfed-central-migrated-v4')) {
        try {
          // 旧增量记录（水位表 / 退避表 / 窗口锚点）已不再使用，清掉免得占着 localStorage。
          // 旧版本会再拼一个 `-<userId>` 后缀（每账号一份），所以按前缀扫全部键，
          // 不能只 removeItem 那三个不带后缀的名字 —— 那样一个都清不掉。
          const stale: string[] = []
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && isLegacyLocalStorageKey(key)) stale.push(key)
          }
          for (const key of stale) localStorage.removeItem(key)
        } catch {
          // localStorage 不可用时忽略
        }
        // 删除旧库（限时 3 秒，超时放弃）
        await destroyLegacyLocalDbs()
        localStorage.setItem('rssfed-central-migrated-v4', '1')
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
   * 标记本地存储已不可用并熔断同步。
   *
   * 只在第一次故障时记录原因：存储坏掉之后，同一库上的操作会以 message 为空的 Error
   * 立即失败，那些错误没有可读信息，堆在 UI 上只会淹没真正的原因。
   */
  function setStorageBroken(detail: string) {
    if (pouchState.storageBroken.value) return
    pouchState.storageBroken.value = detail
  }

  // ── 同步引擎：两个 live 复制（时间线库单向 / 用户状态库双向） ──
  //
  // 服务端聚合之后，浏览器不再逐源同步，因此**没有**一次性复制队列、没有增量水位表、
  // 也没有同步窗口锚点：那三样东西存在的前提是「浏览器自己决定拉哪些源的哪些条目」，
  // 而这个决定已经移到服务端。客户端只剩两个动作：
  //   1. 催服务端聚合（POST /api/timeline/refresh，订阅/打开列表/手动同步时）；
  //   2. 把时间线库 live 复制下来（服务端一写就到端，不需要客户端判断该不该拉）。
  //
  // 关于进度：live 复制也在写库，所以「正在同步」不再等于「用户点了同步」——
  // 状态机只有三档：syncing（有批次在写）/ idle（安静，已跟上服务端）/ error。

  /**
   * 进入列表等场景催服务端聚合的最小间隔。
   *
   * 催促只是把「服务端下一次定时聚合」提前；服务端本身每 5 分钟一轮、抓取到新条目时
   * 还会主动通知，所以不需要每次都打：1 分钟一次足以覆盖「连续切几个页面」的场景。
   * 记在 localStorage（按账号隔离）而不是内存变量：用户反复刷新页面时同样受节流保护。
   */
  const REFRESH_THROTTLE_MS = 60_000

  /**
   * 手动同步时等待「服务端聚合结果到达本地」的上限（毫秒）。
   *
   * 服务端那一段（reconcile）由带 wait=1 的请求负责，这里等的是 live 复制把服务端刚写进去
   * 的文档落到 IndexedDB。超时不算失败：复制没有取消，剩余内容随后自己到端（提示条会显示）。
   */
  const TIMELINE_CATCHUP_WAIT_MS = 10_000

  /** 上次催促服务端聚合的时间戳（localStorage，见 REFRESH_THROTTLE_MS） */
  function loadLastRefreshAt(): number {
    try {
      return Number(localStorage.getItem(lastTimelineRefreshKey(pouchState.dbUserId))) || 0
    } catch {
      return 0
    }
  }

  function saveLastRefreshAt(at: number) {
    try {
      localStorage.setItem(lastTimelineRefreshKey(pouchState.dbUserId), String(at))
    } catch {
      // localStorage 不可用时忽略：最坏结果是多催几次（服务端有 job 去重，多催无副作用）
    }
  }

  /**
   * 催服务端聚合一次。
   *
   * wait=true 时服务端会在本请求里跑完一轮 reconcile 再返回（上限见服务端
   * TIMELINE_REFRESH_WAIT_MS），于是「手动同步」能拿到确切的「本轮新增 N 条」；
   * wait=false 是即发即忘的 202（进入列表时用），数据靠 live 复制自己到端。
   *
   * 失败一律静默（返回 null）：催促只是加速手段，服务端的定时任务与抓取完成通知都会兜底。
   */
  async function requestTimelineRefresh(wait: boolean): Promise<TimelineRefreshResult | null> {
    try {
      return await api.timeline.refresh(wait ? { wait: 1 } : undefined)
    } catch {
      return null
    }
  }

  /** 带节流的催促（自动同步用）；返回本轮有没有真的发出请求 */
  async function refreshServerTimeline(force = false): Promise<boolean> {
    if (pouchState.paused.value || pouchState.storageBroken.value) return false
    const now = Date.now()
    if (!force && now - loadLastRefreshAt() < REFRESH_THROTTLE_MS) return false
    // 先落盘再请求：并发调用都按「刚催过」处理（多催一次无副作用，少催才会慢）
    saveLastRefreshAt(now)
    return (await requestTimelineRefresh(false)) !== null
  }

  /** 停掉时间线 live 复制（暂停同步 / 换账号 / 存储故障时用） */
  function stopTimelineLiveSync() {
    // 先换代次：取消是异步的，之后迟到的回调一律作废
    pouchState.timelineSyncGeneration += 1
    const handle = syncHandles.get(TIMELINE_ID)
    syncHandles.delete(TIMELINE_ID)
    try {
      handle?.cancel()
    } catch {
      // 任务可能已自行结束
    }
  }

  /**
   * 确保时间线库的 live 单向复制在跑（幂等）。
   *
   * live + retry：服务端聚合出新条目后浏览器几秒内自动拿到，不需要用户点任何东西，
   * 也不需要每次打开页面都决定「拉哪个源」—— 这正是服务端聚合改造要买到的东西。
   *
   * restart=true 时先停掉旧句柄再重挂（本地库被重建 / 换账号之后用）。
   */
  async function ensureTimelineLiveSync(restart = false): Promise<void> {
    if (pouchState.paused.value || pouchState.storageBroken.value) return
    if (restart) {
      stopTimelineLiveSync()
    } else {
      if (syncHandles.has(TIMELINE_ID)) return
      // 已有一次挂载流程在跑：等它，而不是另起一条（两条 live 复制写同一个库）
      if (pouchState.timelineSyncPromise) return pouchState.timelineSyncPromise
    }
    const starting = startTimelineLiveSync()
    pouchState.timelineSyncPromise = starting
    try {
      await starting
    } finally {
      if (pouchState.timelineSyncPromise === starting) pouchState.timelineSyncPromise = null
    }
  }

  /** 真正挂上 live 复制的动作（由 ensureTimelineLiveSync 做去重与错误归位） */
  async function startTimelineLiveSync(): Promise<void> {
    /** 本次挂载归属的账号：期间换账号则结果一律作废，不能写进新账号的同步状态 */
    const ownerUserId = pouchState.dbUserId
    const generation = ++pouchState.timelineSyncGeneration
    /** 回调是否还属于当前这一代（暂停 / 换账号 / 重建之后的迟到事件一律丢弃） */
    const isCurrent = () => pouchState.timelineSyncGeneration === generation && pouchState.dbUserId === ownerUserId
    try {
      const url = await remoteUrlForId(TIMELINE_ID).catch(() => null)
      if (!url) {
        if (pouchState.dbUserId === ownerUserId) {
          syncStatuses[TIMELINE_ID] = {
            feedId: TIMELINE_ID,
            status: 'error',
            version: syncStatuses[TIMELINE_ID]?.version ?? 0,
            error: '未取到时间线库名，实时同步未启动'
          }
        }
        return
      }
      // 等待寻址信息期间可能切了账号 / 被暂停 / 熔断：不能拿上一个账号的地址挂到新账号的库上
      if (pouchState.dbUserId !== ownerUserId || pouchState.paused.value || pouchState.storageBroken.value) return

      const task = openEntriesDb().replicate.from(url, {
        live: true,
        retry: true,
        batch_size: REPLICATE_BATCH_SIZE
      })
      const handle = task as unknown as ReplicationTaskHandle
      syncHandles.set(TIMELINE_ID, handle)

      /**
       * 上一次收尾时已经计入「已同步条数」的累计写入数。
       *
       * `docs_written` 是**本次复制实例的累计值**（PouchDB 的 result 对象，
       * 每个批次累加，见 pouchdb 的 writeDocs），live 复制一辈子只创建一次 result，
       * 所以每批的增量必须靠这个基准做差，不能直接把 docs_written 当批大小。
       */
      let lastCountedDocs = 0

      /** 写一个「正在同步」的状态（保留 version，让列表不被无谓刷新） */
      const markSyncing = (patch: Partial<SyncStatus>) => {
        if (!isCurrent()) return
        syncStatuses[TIMELINE_ID] = {
          feedId: TIMELINE_ID,
          status: 'syncing',
          version: syncStatuses[TIMELINE_ID]?.version ?? 0,
          ...patch
        }
      }

      const onChange = (info: unknown) => {
        const i = info as { docs_written?: number, pending?: number }
        markSyncing({
          progress: computeReplicateProgress(i, syncStatuses[TIMELINE_ID]?.progress ?? 0),
          ...(typeof i.docs_written === 'number' ? { docsWritten: i.docs_written } : {}),
          ...(typeof i.pending === 'number' ? { pending: i.pending } : {})
        })
      }

      /**
       * 复制安静下来（已跟上服务端）时收尾：把本批真正写入的文档数累加进「已同步条数」，
       * 有写入才递增 version —— 列表页 watch 的就是它。
       *
       * 「无写入就不递增」不能省：live 复制在「打开应用、服务端没有新内容」时也会 emit 一次
       * paused，照样递增的话每个列表都会白重查一遍本地库。
       */
      const onPaused = () => {
        if (!isCurrent()) return
        const current = syncStatuses[TIMELINE_ID]
        const written = current?.docsWritten ?? 0
        const delta = Math.max(0, written - lastCountedDocs)
        lastCountedDocs = Math.max(lastCountedDocs, written)
        if (delta > 0) {
          pouchState.syncedDocsByTarget[TIMELINE_ID] = (pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0) + delta
        }
        syncStatuses[TIMELINE_ID] = {
          feedId: TIMELINE_ID,
          status: 'idle',
          version: (current?.version ?? 0) + (delta > 0 ? 1 : 0),
          lastSyncedAt: new Date().toISOString()
        }
      }

      const onError = (err: unknown) => {
        if (!isCurrent()) return
        if (isStorageFailure(err)) {
          // live 复制的 retry 会无限重试，存储坏掉时必须主动停下：否则会一直砸在同一块
          // 坏掉的库上（既写不进数据又把错误刷屏），唯一出路是让用户重置本地缓存
          setStorageBroken('本地缓存写入失败（存储空间不足或数据库已损坏），已暂停同步。请到「我的 → 重置本地缓存」清理后重试')
          stopTimelineLiveSync()
          return
        }
        syncStatuses[TIMELINE_ID] = {
          feedId: TIMELINE_ID,
          status: 'error',
          version: syncStatuses[TIMELINE_ID]?.version ?? 0,
          error: errorMessage(err)
        }
      }

      // on 可能不存在（测试里的假任务、极端环境下被剥掉的原型）
      if (typeof handle.on === 'function') {
        handle.on('change', (info: unknown) => onChange(info))
        handle.on('paused', () => onPaused())
        handle.on('error', (err: unknown) => onError(err))
      }

      // 首次挂上先给一个 idle：live 复制要等服务端 _changes 响应才会 emit 事件，
      // 这期间 UI 不该显示「未同步」，也不该残留上一轮的错误
      if (!syncStatuses[TIMELINE_ID] || syncStatuses[TIMELINE_ID]!.status === 'error') {
        syncStatuses[TIMELINE_ID] = {
          feedId: TIMELINE_ID,
          status: 'idle',
          version: syncStatuses[TIMELINE_ID]?.version ?? 0
        }
      }
    } catch (err) {
      // 挂载本身失败（建复制抛错等）：按同步错误上报，等下一次触发再试
      if (pouchState.dbUserId === ownerUserId) {
        syncStatuses[TIMELINE_ID] = {
          feedId: TIMELINE_ID,
          status: 'error',
          version: syncStatuses[TIMELINE_ID]?.version ?? 0,
          error: errorMessage(err)
        }
      }
    }
  }

  /**
   * 催一次服务端聚合（兼容旧调用点的轻量入口：以前是「把这个源加入复制队列」）。
   *
   * 不再接收源 id：服务端按它读到的订阅集合聚合，客户端指定单个源没有意义
   * —— 而「刚订阅完希望立刻看到内容」正是「催一次」要买到的效果。
   */
  function syncFeed() {
    void refreshServerTimeline(true)
  }

  /**
   * 自动同步入口（列表页挂载时调用）。
   *
   * 以前这里按 feeds.lastNewEntryAt 逐个源判断「要不要复制」（还要读水位表与退避表），
   * 现在这个判断在服务端（reconcile 内部一条 SQL 比完），客户端只做两件事：
   * 确保 live 复制在跑、带节流地催一次聚合。`feeds` 参数保留用于「没有订阅就短路」。
   */
  async function syncFeedsIfChanged(feeds: Array<{ feedId: string, lastNewEntryAt?: string }> = []): Promise<number> {
    if (pouchState.paused.value) return 0
    // 等迁移清理完成：旧本地库（rssfed-entries-*）还占着空间，且结构与新版不兼容
    await ensureCleanup()
    if (feeds.length === 0) return 0
    await ensureTimelineLiveSync()
    const requested = await refreshServerTimeline()
    return requested ? feeds.length : 0
  }

  /** 等「已同步条数」超过 before（首屏优先同步用，有界、不抛错） */
  async function waitForTimelineActivity(before: number, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs
    for (;;) {
      if ((pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0) > before) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  /**
   * 「优先同步当前列表」：语义已变成「催一次聚合，并等这一批到端」。
   *
   * 以前它决定「先复制当前列表涉及的那几个源」，现在所有源都在同一个时间线库里、
   * 服务端一次聚合全带上，所以参数不再影响行为 —— 保留这个无参签名是为了让各列表页的
   * 首屏逻辑（useListFirstPaint）不用各写一份。
   *
   * 这里**不用** wait=1 的同步请求：首屏等待上限是 5s，而服务端一轮聚合可能更久
   * （新订阅要回填窗口内的历史与图片），把首屏挂在 HTTP 请求上会变成「白屏十几秒」。
   */
  async function syncPriority(waitMs: number = PRIORITY_SYNC_WAIT_MS): Promise<PrioritySyncResult> {
    if (pouchState.paused.value) return { done: true, added: 0, skipped: 0 }
    const before = pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0
    const started = Date.now()
    const requested = await refreshServerTimeline(true)
    await ensureTimelineLiveSync()
    // 剩下的小预算用来等数据到端（催促本身也花了时间，从预算里扣掉）
    const done = await waitForTimelineActivity(before, Math.max(0, waitMs - (Date.now() - started)))
    const added = Math.max(0, (pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0) - before)
    return { done, added, skipped: requested ? 0 : 1 }
  }

  /**
   * 手动同步（工具栏按钮 / 侧边栏指示器）。
   *
   * 与旧实现的区别：不再由客户端逐源增量复制，而是
   *   ① 让服务端**在本请求里**跑完一轮聚合（wait=1，拿得到确切的新增条数），
   *   ② 等 live 复制把结果落到本地（有界，超时不报失败）。
   *
   * `added` 取「服务端写入派生库的条数」与「本地实际收到的条数」的较大值：服务端聚合很快
   * 时前者准，服务端超时后（后台继续跑完）后者准。
   */
  async function syncNow(): Promise<SyncNowResult> {
    // 点同步即视为恢复：暂停由用户显式点停，点同步就是要它重新开始
    resumeSync()
    const before = pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0
    const res = await requestTimelineRefresh(true)
    if (!res) {
      return {
        ok: [],
        failed: [{ id: TIMELINE_ID, error: '无法联系服务端触发聚合（离线或登录已过期）' }],
        skipped: 0,
        added: 0,
        serverPending: false
      }
    }
    const serverAdded = typeof res.added === 'number' ? res.added : 0
    await ensureTimelineLiveSync()
    await waitForTimelineCatchup(serverAdded, TIMELINE_CATCHUP_WAIT_MS)
    const clientAdded = Math.max(0, (pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0) - before)
    const added = Math.max(serverAdded, clientAdded)
    return {
      ok: [TIMELINE_ID],
      failed: [],
      // 服务端本轮没有新内容、或它仍在后台聚合：报「跳过」，
      // 让 toast 说清「已是最新 / 仍在服务端聚合」，而不是含糊的「同步完成」
      skipped: added > 0 ? 0 : 1,
      added,
      serverPending: res.completed === false
    }
  }

  /**
   * 等服务端刚聚合出的文档到达本地：本地「已同步条数」涨到 before + serverAdded 即算到齐；
   * 复制已经安静且确实有写入时也提前返回（条数里还含 FeedDoc 等，不必严格相等）。
   */
  async function waitForTimelineCatchup(serverAdded: number, waitMs: number): Promise<boolean> {
    if (serverAdded <= 0) return true
    const before = pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0
    const deadline = Date.now() + waitMs
    for (;;) {
      const now = pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0
      if (now >= before + serverAdded) return true
      if (now > before && syncStatuses[TIMELINE_ID]?.status === 'idle') return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 200))
    }
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
   * 导致旧数据残留），清空后 live 复制会从头把时间线重新拉下来。
   *
   * 只清本地：服务端的派生库不动（那是「再拉一次」的来源）。
   */
  async function resetLocalData() {
    // 停掉 live 复制再删库：否则在途的写入会砸在一个已被销毁的实例上
    stopTimelineLiveSync()
    // 销毁本地时间线库（旧数据/冲突分支一并清除），下次访问自动重建空库
    if (pouchState.entriesDb) {
      await pouchState.entriesDb.destroy().catch(() => {})
      pouchState.entriesDb = null
    }
    pouchState.entriesIndexed = false
    feedIconBlobs.clear()
    entryCoverBlobs.clear()
    // 促催时间也清掉：重建之后立刻就要能催一次服务端
    try {
      localStorage.removeItem(lastTimelineRefreshKey(pouchState.dbUserId))
    } catch {
      // localStorage 不可用时忽略
    }
    // 存储故障已通过重建本地库解除：清掉熔断标记，让后续同步可以继续
    pouchState.storageBroken.value = null
    // 同步状态重置为未同步（用 Reflect.deleteProperty 而不是 delete：后者对动态键会破坏
    // V8 的对象形状优化）
    for (const key of Object.keys(syncStatuses)) {
      Reflect.deleteProperty(syncStatuses, key)
    }
    for (const key of Object.keys(pouchState.syncedDocsByTarget)) {
      Reflect.deleteProperty(pouchState.syncedDocsByTarget, key)
    }
    // 代理寻址信息一并失效：服务端库重建后库名可能已变
    invalidateTargets()
    // 重新挂上 live 复制（新库是空的，会从头全量拉一次）。
    // 这里 await 而不是即发即忘：重置的调用方紧接着就要催同步，句柄没挂上会白等一轮
    await ensureTimelineLiveSync(true)
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
    return queryViewFrom(view, feedId, null, limit)
  }

  /**
   * 视图范围查询（desc）：从 `after`（**含**该行）往下取 limit 行。
   *
   * after 为 null 表示从最新一行开始（等价于原来的「只给 limit」翻页）。
   * 端点用 startkey 而不是 skip：skip 在 CouchDB/PouchDB 里要先走完被跳过的行，
   * 深翻时会退化成 O(偏移量)。含端点带来的重复行由 scanPageRows 负责丢掉。
   */
  async function queryViewFrom(
    view: string,
    feedId: string | undefined,
    after: ScanCursor | null,
    limit: number
  ): Promise<RssEntry[]> {
    const db = getEntriesDb()
    await ensureLocalViews()
    const opts: Record<string, unknown> = { descending: true, include_docs: false, reduce: false, limit }
    // 限定到 feed 桶内：desc 起点取该 feed 最新的一条（未传游标时是 [feedId, MAX, '']）。
    // 关键：desc 只给 startkey 会沿索引一路扫到开头，越过桶底串进其它 feed；
    // 必须再用 endkey=[feedId] 兜住桶底。数组键里 [feedId] 排在全部 [feedId,*] 之前，
    // 且不会有行恰等于该键，因此正好在不漏本桶的同时把扫描截断在桶边界。
    if (feedId !== undefined) {
      opts.startkey = after ? [feedId, after.ms, after.id] : [feedId, VIEW_MAX_TS, '']
      opts.endkey = [feedId]
    } else if (after) {
      opts.startkey = [after.ms, after.id]
    }
    try {
      const res = await db.query(view, opts)
      return res.rows.map(rowToEntry)
    } catch {
      return []
    }
  }

  /** 扫描一页的默认批量：投影行很小（不带正文与附件），比列表的 50 大得多才划算 */
  const SCAN_PAGE_SIZE = 300

  /**
   * 取一页投影行（不给已读态、不 enrich）。
   *
   * `start` 是查询起点且含端点。`dropStart` 表示这个起点是「上一页的末尾」——
   * 多要一行用来抵消端点重复（游标行若已被删就自然少一行），保证页与页不重不漏。
   * 返回 <= limit 行，`rows.length < limit` 即已读到底。
   */
  async function scanPageRows(
    view: string,
    feedId: string | undefined,
    start: ScanCursor | null,
    limit: number,
    dropStart: boolean
  ): Promise<RssEntry[]> {
    const rows = await queryViewFrom(view, feedId, start, dropStart ? limit + 1 : limit)
    if (dropStart && start && rows[0]?.id === start.id) rows.shift()
    return rows.slice(0, limit)
  }

  /** 由一页投影行推出续扫游标（页尾那行的 key）与是否已扫到底 */
  function cursorOfPage(rows: RssEntry[], limit: number): { cursor: ScanCursor, exhausted: boolean } {
    const last = rows[rows.length - 1]
    return {
      cursor: last
        ? { ms: Date.parse(last.publishedAt), id: last.id }
        : { ms: VIEW_MAX_TS, id: '' },
      exhausted: rows.length < limit
    }
  }

  /**
   * 时间线扫描一页：**只合已读态，不做 enrich**。
   *
   * 「只看未读」要沿时间序深挖才能凑够一屏未读，而 enrich（源元信息 + 封面附件 + blob URL）
   * 是上屏才该付的成本 —— 扫到的行绝大多数会被丢掉，给它们取封面纯属浪费。
   * 已读态必须合（否则挑不出未读），但那只是一次批量 allDocs，没有附件与 DOM。
   *
   * 扫描**不受列表快照约束**：从游标（首轮为 null = 本地库最新一条）沿时间序往下走，
   * 同步刚写进来的条目也在范围内 —— 「只看未读」进来的那一下就是要一次完整刷新。
   */
  async function scanTimelinePage(
    after: ScanCursor | null,
    limit = SCAN_PAGE_SIZE
  ): Promise<ScanPage> {
    const rows = await scanPageRows(TIMELINE_VIEW, undefined, after, limit, after !== null)
    await attachReadState(rows)
    return { rows, ...cursorOfPage(rows, limit) }
  }

  /** 单个订阅源的扫描一页：语义同 scanTimelinePage，只是限定在该源的桶内 */
  async function scanFeedPage(
    feedId: string,
    after: ScanCursor | null,
    limit = SCAN_PAGE_SIZE
  ): Promise<ScanPage> {
    const rows = await scanPageRows(BY_FEED_VIEW, feedId, after, limit, after !== null)
    await attachReadState(rows)
    return { rows, ...cursorOfPage(rows, limit) }
  }

  /**
   * 分组扫描一页：每源各取一页再按时间归并，游标按源分别记。
   *
   * 归并可能在某源的页中间停下（已经凑够 limit 行），该源的续扫游标就停在**已消费的最后一行**；
   * 该源这一页没被消费的行下一轮会重新读一遍 —— 多花一点读，但不漏行。
   */
  async function scanGroupPage(
    feedIds: string[],
    after: GroupScanCursor | null,
    limit = SCAN_PAGE_SIZE
  ): Promise<ScanPage<GroupScanCursor>> {
    if (feedIds.length === 0) return { rows: [], cursor: { byFeed: {} }, exhausted: true }
    const cursors = after?.byFeed ?? {}

    const perFeed = await Promise.all(feedIds.map((id) => {
      const cursor = cursors[id]
      return scanPageRows(BY_FEED_VIEW, id, cursor ?? null, limit, cursor !== undefined)
    }))

    const ptr = perFeed.map(() => 0)
    const rows: RssEntry[] = []
    while (rows.length < limit) {
      let bestIdx = -1
      let bestTs = -Infinity
      for (let i = 0; i < perFeed.length; i++) {
        const row = perFeed[i]![ptr[i]!]
        if (!row) continue
        const ts = Date.parse(row.publishedAt)
        if (ts > bestTs) {
          bestTs = ts
          bestIdx = i
        }
      }
      if (bestIdx === -1) break
      rows.push(perFeed[bestIdx]![ptr[bestIdx]!]!)
      ptr[bestIdx]!++
    }

    // 只保留当前订阅源集合的游标：退订的源不该在游标里留残留
    const nextByFeed: Record<string, ScanCursor> = {}
    for (const id of feedIds) {
      const cursor = cursors[id]
      if (cursor) nextByFeed[id] = cursor
    }
    for (let i = 0; i < perFeed.length; i++) {
      const consumed = ptr[i]!
      if (consumed === 0) continue
      const last = perFeed[i]![consumed - 1]!
      nextByFeed[feedIds[i]!] = { ms: Date.parse(last.publishedAt), id: last.id }
    }

    // 每个源都「取不满一页且已全部消费」才算扫到底
    const exhausted = perFeed.every((feedRows, i) => feedRows.length < limit && ptr[i] === feedRows.length)
    await attachReadState(rows)
    return { rows, cursor: { byFeed: nextByFeed }, exhausted }
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

    // 存入 handle：live 句柄统一由 syncHandles 管理（暂停/换账号时逐个 cancel）
    syncHandles.set(key, sync as unknown as ReplicationTaskHandle)
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
    /** 催一次服务端聚合（订阅完成、手动触发的轻量入口） */
    syncFeed,
    /** 页面挂载时的自动同步：确保 live 复制在跑 + 带节流地催一次聚合 */
    syncFeedsIfChanged,
    /** 手动同步：让服务端在本请求内跑完一轮聚合，并等结果落到本地 */
    syncNow,
    /**
     * 优先同步当前列表并等它跑完（或 5s 超时），供列表页「先同步再显示」用。
     * 见 syncPriority 的说明（不抛错、超时不取消复制）。
     */
    syncPriority,
    /**
     * 「本地时间线本次会话已写入的文档数」的响应式计数。
     *
     * 列表页据此显示「已同步 N 条」提示条：**全库口径**（时间线是唯一同步目标），
     * 所以任何源的新条目都会让它上涨 —— 提示条表达的是「本地时间线里多了 N 条还没看」。
     */
    syncedDocsByTarget: pouchState.syncedDocsByTarget,
    /**
     * 时间线库的同步版本号（响应式）：每批新内容落库后 +1。
     * 列表页 watch 它来累计「已同步 N 条」（见 useSyncedEntryList 的 refreshFromSync）。
     */
    timelineVersion: computed(() => syncStatuses[TIMELINE_ID]?.version ?? 0),
    /** 本地时间线本次会话已写入的文档数（响应式读取，列表页作为 syncedDocs 回调） */
    timelineSyncedDocs: () => pouchState.syncedDocsByTarget[TIMELINE_ID] ?? 0,
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
    /**
     * 把「投影行」补成可上屏的条目（源名 / 站点 / 图标 / 封面 blob URL）。
     * 只有真要上屏的条目才该走它 —— 扫描阶段一律不调用（见 scanTimelinePage 的说明）。
     */
    enrichEntries,
    /** 「只看未读」的深扫：按游标分批走视图，只合已读态、不 enrich */
    scanTimelinePage,
    scanFeedPage,
    scanGroupPage,
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
