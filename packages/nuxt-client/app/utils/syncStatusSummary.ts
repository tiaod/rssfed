/**
 * 侧边栏同步状态指示器的纯逻辑部分。
 *
 * 只依赖最小的状态形状（不 import usePouchDb），方便单测；组件负责订阅
 * usePouchSyncStatus 并把它传进来。
 */

/** 单个库的同步状态里本模块需要的字段（结构兼容 usePouchDb 的 SyncStatus） */
export interface SyncStatusLike {
  status: 'syncing' | 'idle' | 'error' | 'queued'
  error?: string
  lastSyncedAt?: string
  /** 库内部的拉取进度（0-100）；undefined 表示服务端还没返回可用的变更余量 */
  progress?: number
  /** 本次复制已写入的文档数 */
  docsWritten?: number
}

export type SyncState = 'syncing' | 'error' | 'success' | 'idle' | 'paused' | 'storage-error'

/** 正在同步的某个库的进度明细（供指示器弹层逐条展示） */
export interface SyncingDetail {
  feedId: string
  progress?: number
  docsWritten?: number
}

export interface SyncStatusSummary {
  /** 整体状态：同步中 / 失败 / 成功 / 已暂停 / 本地存储故障 / 尚无记录 */
  state: SyncState
  /** 参与同步的库总数 */
  total: number
  syncing: number
  queued: number
  /** 尚未完成的库数量（排队 + 进行中） */
  remaining: number
  /** 已完成的库数量（成功 + 失败） */
  done: number
  /**
   * 本轮进度（0-100）。
   *
   * 已完成的库记满 1，正在同步的库按其内部进度折算（见 usePouchDb 的 change 监听）：
   * 一个 200 条的源拉到一半，进度条会走到 0.5/total 而不是原地不动。
   * 排在队尾的库没有进度信息，记 0。
   */
  progress: number
  /** 正在同步的库及其内部进度（顺序与状态表一致，最多 MAX_SYNCING_DETAILS 条） */
  syncingDetails: SyncingDetail[]
  /** 失败的库数量（含未带失败原因的） */
  errorCount: number
  /** 失败原因（按库去重前的原始顺序，可能少于 errorCount） */
  errors: string[]
  /** 最近一次成功同步的时间（ISO 字符串） */
  lastSyncedAt: string | null
  /** 本地存储故障说明（非空表示本轮同步已被熔断，需要重置本地缓存） */
  storageError: string | null
}

/** 弹层里最多逐条列出的「正在同步」库数量（并发上限是 2，留点余量） */
export const MAX_SYNCING_DETAILS = 4

/**
 * 汇总所有库的同步状态。
 *
 * 状态优先级：本地存储故障 > 暂停 > 同步中 > 失败 > 成功 > 无记录。
 * 存储故障排最前：此时同步已被熔断，继续显示「正在同步」或「已暂停」都会误导用户
 * （真正要做的是重置本地缓存）。paused 由调用方从共享状态传入（用户点了「暂停同步」）；
 * 只要还有一个库在排队/进行中就先显示「正在同步」；这轮全部结束后失败优先于成功，
 * 避免把失败盖掉。
 */
export function summarizeSyncStatuses(
  statuses: Record<string, SyncStatusLike>,
  options: { paused?: boolean, storageError?: string | null } = {}
): SyncStatusSummary {
  const list = Object.values(statuses)
  const syncing = list.filter(s => s.status === 'syncing').length
  const queued = list.filter(s => s.status === 'queued').length
  const done = list.filter(s => s.status === 'idle' || s.status === 'error').length
  // 失败与否看 status，文案另算：偶尔会有 status 为 error 但没带原因的库
  const errorCount = list.filter(s => s.status === 'error').length
  const errors = list
    .filter(s => s.status === 'error' && !!s.error)
    .map(s => s.error as string)
  const times = list.map(s => s.lastSyncedAt).filter((t): t is string => !!t)
  // ISO 字符串可直接按字典序比较，取最大的即最近一次
  const lastSyncedAt = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null
  const remaining = syncing + queued
  const total = list.length
  const storageError = options.storageError ?? null

  const state: SyncState = storageError
    ? 'storage-error'
    : options.paused
      ? 'paused'
      : remaining > 0
        ? 'syncing'
        : errorCount > 0
          ? 'error'
          : lastSyncedAt
            ? 'success'
            : 'idle'

  // 正在同步的库逐条列出（含内部进度）：并发上限只有两个，弹层能一条一条说清楚
  // 「哪个源、拉到几成」，比只报一个总数更贴近用户在看的东西
  const syncingDetails: SyncingDetail[] = Object.entries(statuses)
    .filter(([, s]) => s.status === 'syncing')
    .slice(0, MAX_SYNCING_DETAILS)
    .map(([feedId, s]) => ({
      feedId,
      ...(typeof s.progress === 'number' ? { progress: s.progress } : {}),
      ...(typeof s.docsWritten === 'number' ? { docsWritten: s.docsWritten } : {})
    }))

  // 源内进度加权：完成的库记满，进行中的库按内部百分比折算。
  // 沿用「已完成库数 / 总库数」会让一个几千条的源在拉到一半时进度条纹丝不动
  // （它只贡献 1/total），而进展恰恰全发生在这个源内部。
  const progressUnits = Object.values(statuses).reduce((sum, s) => {
    if (s.status === 'idle' || s.status === 'error') return sum + 1
    if (s.status === 'syncing') return sum + (s.progress ?? 0) / 100
    return sum
  }, 0)

  return {
    state,
    total,
    syncing,
    queued,
    remaining,
    done,
    progress: total === 0 ? 0 : Math.min(100, Math.round(progressUnits / total * 100)),
    syncingDetails,
    errorCount,
    errors,
    lastSyncedAt,
    storageError
  }
}

/**
 * 同步时间的相对文案：1 分钟内「刚刚」，1 小时内「x 分钟前」，更早显示时分。
 * now 可注入，便于单测。
 */
export function formatSyncedAt(iso: string, now: number = Date.now()): string {
  const diffMin = Math.floor((now - new Date(iso).getTime()) / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const LABELS: Record<SyncState, string> = {
  'syncing': '正在同步',
  'error': '同步失败',
  'success': '同步成功',
  'idle': '尚未同步',
  'paused': '同步已暂停',
  'storage-error': '本地缓存写入失败'
}

/** 弹层标题：成功 / 失败 / 同步中 / 已暂停 / 本地存储故障 / 无记录 */
export function syncStatusLabel(state: SyncState): string {
  return LABELS[state]
}

/**
 * 单个正在同步的库的明细行文案。
 *
 * 不显示 feedId：它是远端 CouchDB 的随机库名（形如 `4f3a…`），对用户没有意义，
 * 侧边栏里的订阅名又拿不到（本模块刻意不依赖任何数据源）。因此这里只说
 * 「拉到几成、已写入多少条」——这正是用户点开弹层想看的信息。
 *
 * progress 为 undefined 表示服务端还没返回变更余量（见 usePouchDb 的 change 监听），
 * 此时不能显示 0%（那是谎报），只说「正在拉取」。
 */
function syncingDetailLine(item: SyncingDetail): string {
  const written = item.docsWritten ?? 0
  if (item.progress === undefined) {
    return written > 0 ? `正在拉取（已同步 ${written} 条）` : '正在拉取…'
  }
  // 进度条已经满格但库还没结束：最后一批（含 checkpoint 写入）在路上
  if (item.progress >= 100) {
    return written > 0 ? `即将完成（已同步 ${written} 条）` : '即将完成'
  }
  return written > 0
    ? `已同步 ${item.progress}%（${written} 条）`
    : `已同步 ${item.progress}%`
}

/** 弹层明细行：同步中看进度，失败看原因，成功看时间与覆盖范围，已暂停看提示 */
export function syncStatusDetails(
  summary: SyncStatusSummary,
  now: number = Date.now()
): string[] {
  // 存储故障优先于其它状态：此时同步已被熔断，继续拉取只会把剩余任务全部失败掉，
  // 用户唯一有效的动作是重置本地缓存
  if (summary.state === 'storage-error') {
    return [
      summary.storageError ?? '本地缓存写入失败，已暂停同步',
      '点击可重置本地缓存并重新同步'
    ]
  }

  // 暂停优先于其它状态：此时库里可能还留着上一轮的失败记录，但用户此刻关心的是「不再拉取」
  if (summary.state === 'paused') {
    return ['已停止拉取新内容']
  }

  if (summary.state === 'syncing') {
    const lines = [`剩余 ${summary.remaining} / ${summary.total} 个订阅源（${summary.progress}%）`]
    for (const item of summary.syncingDetails) {
      lines.push(syncingDetailLine(item))
    }
    return lines
  }

  if (summary.state === 'error') {
    const lines = [summary.errors[0] ?? '同步失败，请稍后重试']
    if (summary.errorCount > 1) lines.push(`另有 ${summary.errorCount - 1} 个订阅源同步失败`)
    if (summary.lastSyncedAt) lines.push(`上次成功同步：${formatSyncedAt(summary.lastSyncedAt, now)}`)
    return lines
  }

  if (summary.state === 'success') {
    const lines: string[] = []
    if (summary.lastSyncedAt) lines.push(`上次同步：${formatSyncedAt(summary.lastSyncedAt, now)}`)
    lines.push(`共 ${summary.total} 个订阅源`)
    return lines
  }

  return ['本次会话还没有同步记录']
}
