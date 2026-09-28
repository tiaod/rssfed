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
}

export type SyncState = 'syncing' | 'error' | 'success' | 'idle' | 'paused'

export interface SyncStatusSummary {
  /** 整体状态：同步中 / 失败 / 成功 / 已暂停 / 尚无记录 */
  state: SyncState
  /** 参与同步的库总数 */
  total: number
  syncing: number
  queued: number
  /** 尚未完成的库数量（排队 + 进行中） */
  remaining: number
  /** 已完成的库数量（成功 + 失败） */
  done: number
  /** 本轮进度（0-100，按已完成库数占比） */
  progress: number
  /** 失败的库数量（含未带失败原因的） */
  errorCount: number
  /** 失败原因（按库去重前的原始顺序，可能少于 errorCount） */
  errors: string[]
  /** 最近一次成功同步的时间（ISO 字符串） */
  lastSyncedAt: string | null
}

/**
 * 汇总所有库的同步状态。
 *
 * 状态优先级：暂停 > 同步中 > 失败 > 成功 > 无记录。paused 由调用方从共享状态传入
 * （用户点了「暂停同步」）；只要还有一个库在排队/进行中就先显示「正在同步」；
 * 这轮全部结束后失败优先于成功，避免把失败盖掉。
 */
export function summarizeSyncStatuses(
  statuses: Record<string, SyncStatusLike>,
  options: { paused?: boolean } = {}
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

  const state: SyncState = options.paused
    ? 'paused'
    : remaining > 0
      ? 'syncing'
      : errorCount > 0
        ? 'error'
        : lastSyncedAt
          ? 'success'
          : 'idle'

  return {
    state,
    total,
    syncing,
    queued,
    remaining,
    done,
    progress: total === 0 ? 0 : Math.round(done / total * 100),
    errorCount,
    errors,
    lastSyncedAt
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
  syncing: '正在同步',
  error: '同步失败',
  success: '同步成功',
  idle: '尚未同步',
  paused: '同步已暂停'
}

/** 弹层标题：成功 / 失败 / 同步中 / 已暂停 / 无记录 */
export function syncStatusLabel(state: SyncState): string {
  return LABELS[state]
}

/** 弹层明细行：同步中看进度，失败看原因，成功看时间与覆盖范围，已暂停看提示 */
export function syncStatusDetails(
  summary: SyncStatusSummary,
  now: number = Date.now()
): string[] {
  // 暂停优先于其它状态：此时库里可能还留着上一轮的失败记录，但用户此刻关心的是「不再拉取」
  if (summary.state === 'paused') {
    return ['已停止拉取新内容']
  }

  if (summary.state === 'syncing') {
    return [`剩余 ${summary.remaining} / ${summary.total} 个订阅源（${summary.progress}%）`]
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
