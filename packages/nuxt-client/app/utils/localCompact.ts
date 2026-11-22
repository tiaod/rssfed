/**
 * 「什么时候该压缩本地库」的判定（纯函数，便于单测）。
 *
 * 为什么需要压缩：PouchDB 只有 `compact()` 才会删掉**不再是叶子**的旧修订正文，以及
 * 「不再被任何修订引用」的附件 blob（见 pouchdb 的 compactRevs）。服务端那份在裁剪 /
 * 库里发生过批量清理之后会显式 compact（hono-server 的 couchdb/retention.ts），
 * 本地这份没人压：删掉的条目的正文与图片会一直留在 IndexedDB 里 —— 这就是「本站缓存」
 * 比「云端库」大出好几成、而且只增不减的主要原因。
 *
 * 为什么不在每次同步结束后都压：压缩要把整个库扫一遍，几百 MB 的库是实打实的 IO/CPU；
 * 而一天内新增的墓碑与旧修订有限，压缩收益是天级的。所以只在**同步空闲下来**之后压一次，
 * 并且按天节流。
 */

/**
 * 同步安静下来之后等多久再压（毫秒）。
 *
 * 不能太短：live 复制刚 paused 时用户往往正在翻列表，压缩会和刷新/滚动抢 IO；
 * 30 秒足够让「刚打开应用」那一轮同步的收尾工作（列表查询、图片解码）先跑完。
 */
export const COMPACT_IDLE_DELAY_MS = 30_000

/** 两次压缩之间的最小间隔（一天）：回收收益按天计，压得太勤只是白耗电 */
export const COMPACT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface CompactGateState {
  /** 当前时间（毫秒） */
  now: number
  /** 上次压缩完成的时间；从未压缩过为 0 */
  lastCompactedAt: number
  /** 是否有同步在进行（syncing / queued） */
  syncing: boolean
  /** 用户是否手动暂停了同步 */
  paused: boolean
  /** 本地存储是否已熔断（配额/损坏） */
  storageBroken: boolean
  /** 本地库实例是否存在 */
  hasDb: boolean
}

/**
 * 现在能不能压：库在、同步空闲、没被用户暂停、存储没坏、距上次压缩超过一天。
 *
 * 任一条件不满足都只是「这轮不压」，等下一次 paused 再判断 —— 压缩没有正确性意义，
 * 晚一天压不影响任何功能。
 */
export function shouldCompactNow(state: CompactGateState): boolean {
  if (!state.hasDb || state.syncing || state.paused || state.storageBroken) return false
  return state.now - state.lastCompactedAt >= COMPACT_MIN_INTERVAL_MS
}

/**
 * 视图索引多久追平一次（毫秒）。
 *
 * 比压缩勤得多：PouchDB 的 map view 是懒的，索引落后多少，用户点「查看」那一下就要补多少
 * （实测落后 2000 条时首次查询 880ms，而索引是热的时候只要 7ms）。而追平本身很便宜 ——
 * 一次 `limit: 1` 的查询，只是把 updateView 提前到没人看的时候跑。
 * 比裁剪短是因为它没有破坏性、也几乎不写盘：索引行本来就是查询要用的东西。
 */
export const INDEX_CATCHUP_MIN_INTERVAL_MS = 10 * 60 * 1000

export interface IndexCatchupGateState {
  /** 当前时间（毫秒） */
  now: number
  /** 上次追平完成的时间；从未追平过为 0 */
  lastIndexCaughtUpAt: number
  /** 是否有同步在进行（syncing / queued） */
  syncing: boolean
  /** 用户是否手动暂停了同步 */
  paused: boolean
  /** 本地存储是否已熔断（配额/损坏） */
  storageBroken: boolean
  /** 本地库实例是否存在 */
  hasDb: boolean
}

/**
 * 现在要不要追平索引：与压缩同一组闸门，只有节流间隔不同。
 *
 * 与裁剪 / 压缩一样在同步中不追：复制正往库里写，updateView 会把这一批也扫一遍，
 * 等它写完再追一次就是白扫（追平是「追上就停」，写新数据又会让它落后）。
 */
export function shouldCatchUpIndexNow(state: IndexCatchupGateState): boolean {
  if (!state.hasDb || state.syncing || state.paused || state.storageBroken) return false
  return state.now - state.lastIndexCaughtUpAt >= INDEX_CATCHUP_MIN_INTERVAL_MS
}

/**
 * 两次**裁剪**之间的最小间隔（一小时）。
 *
 * 比压缩的节流短得多，因为裁剪很便宜：它只是每个源读一页视图、算出差集，**没有**要删的东西时
 * 一个写事务都不会开。而它的收益是「退订后条目尽快消失」—— 用户刚退订一个源，一小时内在时间线
 * 上还看得见它的旧文章，是能被感知到的困扰。压缩（扫全库）就不同，所以它按天。
 */
export const TRIM_MIN_INTERVAL_MS = 60 * 60 * 1000

export interface TrimGateState {
  /** 当前时间（毫秒） */
  now: number
  /** 上次裁剪完成的时间；从未裁剪过为 0 */
  lastTrimmedAt: number
  /** 是否有同步在进行（syncing / queued） */
  syncing: boolean
  /** 用户是否手动暂停了同步 */
  paused: boolean
  /** 本地存储是否已熔断（配额/损坏） */
  storageBroken: boolean
  /** 本地库实例是否存在 */
  hasDb: boolean
}

/**
 * 现在能不能裁：与压缩同一组闸门，只有节流间隔不同。
 *
 * 同步中不裁是硬要求：裁剪会读订阅集合（要和正在被复制写入的库比对），在复制跑着的时候
 * 算出的「退订源」可能只是订阅文档还没落库，删了就是误删 —— 下一轮同步也不会补回来
 *（`_purge` 过的文档不进 `_changes`，条目本身也没变过，复制不会重发）。
 */
export function shouldTrimNow(state: TrimGateState): boolean {
  if (!state.hasDb || state.syncing || state.paused || state.storageBroken) return false
  return state.now - state.lastTrimmedAt >= TRIM_MIN_INTERVAL_MS
}

/**
 * 用户停手多久才算「空下来」（毫秒）。
 *
 * 同步刚 paused 不代表用户闲着 —— 那往往正是他点开列表、往下翻的时刻。空闲维护（追平索引 /
 * 裁剪 / 压缩）在这段时间里跑，就会和列表查询抢同一批 IndexedDB 事务：实测「压缩 + 冷索引
 * 查询」叠在一起，一次点「查看」从 7ms 变成 2 秒。8 秒是「一屏读完、手指停住」的量级，
 * 比这更短会把正常阅读的停顿也当成空闲。
 */
export const IDLE_QUIET_MS = 8_000

/** 让位最多让多久（毫秒）：到点就不再等用户停手，照常维护 */
export const IDLE_MAX_POSTPONE_MS = 5 * 60_000

/** 让位期间的最小复查间隔（毫秒），防止紧贴安静边界时空转 */
export const IDLE_RECHECK_MS = 1_000

export interface IdleWindowState {
  /** 当前时间（毫秒） */
  now: number
  /** 用户最后一次操作的时间；0 表示这次会话里还没记到过（当作早就安静了） */
  lastActivityAt: number
  /** 页面是否在后台 */
  documentHidden: boolean
  /** 这轮维护第一次到期的时间；0 表示现在就是第一次到期 */
  dueSince: number
}

export type IdleWindowDecision
  = | { run: true, reason: 'quiet' | 'hidden' | 'deadline' }
    | { run: false, retryInMs: number }

/**
 * 现在是不是能动手维护的窗口：要么用户已经停手，要么页面在后台（没人可打扰）。
 *
 * 但让位**必须有上限**：用户连着用几分钟的情况很常见（翻列表、开文章），无限让位等于让维护
 * 永远跑不上 —— 索引越拖越厚，下一次点「查看」还是卡那几秒，正是这套机制要解决的问题本身。
 * 所以超过 IDLE_MAX_POSTPONE_MS 就照常跑：宁可让用户等这一下，也不能让索引永远追不平。
 */
export function decideIdleRun(state: IdleWindowState): IdleWindowDecision {
  if (state.documentHidden) return { run: true, reason: 'hidden' }
  // lastActivityAt 为 0 是「没记到过操作」，不是「一秒前刚操作过」——
  // 算成负数的话刚打开应用、用户还没动过手指时就永远不会维护
  const quiet = state.lastActivityAt === 0
    ? Number.POSITIVE_INFINITY
    : state.now - state.lastActivityAt
  if (quiet >= IDLE_QUIET_MS) return { run: true, reason: 'quiet' }

  const waited = state.dueSince === 0 ? 0 : state.now - state.dueSince
  if (waited >= IDLE_MAX_POSTPONE_MS) return { run: true, reason: 'deadline' }

  const retryInMs = Math.min(
    Math.max(IDLE_RECHECK_MS, IDLE_QUIET_MS - quiet),
    IDLE_MAX_POSTPONE_MS - waited
  )
  return { run: false, retryInMs }
}
