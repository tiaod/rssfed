/**
 * 「什么时候该压缩本地库」的判定（纯函数，便于单测）。
 *
 * 为什么需要压缩：PouchDB 只有 `compact()` 才会删掉**不再是叶子**的旧修订正文，以及
 * 「不再被任何修订引用」的附件 blob（见 pouchdb 的 compactRevs）。服务端那份在裁剪 /
 * 墓碑 GC 之后会显式 compact（hono-server 的 couchdb/retention.ts、tombstone-gc.ts），
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
