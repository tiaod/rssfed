import type { BackgroundSyncEvent } from '~/utils/backgroundSyncLog'

/**
 * Background Sync 日志面板的纯展示逻辑（徽标映射 / 时间格式化）。
 *
 * 与 utils/timelineLog 分开是因为数据源完全不同：那份读服务端 `timeline_events`，
 * 这份读浏览器本地 IndexedDB（SW 与页面共写）。混在一起会让「哪条是服务端说的、
 * 哪条是本机说的」在排查时糊掉 —— 而这恰恰是最需要分清的一件事。
 */

/** kind → 徽标文案 */
const KIND_LABELS: Record<string, string> = {
  'unsupported': '不支持',
  'armed': '已登记',
  'arm-failed': '登记失败',
  'sync-start': '已触发',
  'sync-ok': '成功',
  'sync-failed': '失败'
}

export function backgroundSyncEventLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** 徽标颜色：成功绿、失败红、已触发蓝，其余中性 */
export function backgroundSyncEventColor(
  kind: string
): 'neutral' | 'info' | 'success' | 'warning' | 'error' {
  if (kind === 'sync-ok') return 'success'
  if (kind === 'sync-failed' || kind === 'arm-failed') return 'error'
  if (kind === 'unsupported') return 'warning'
  if (kind === 'sync-start' || kind === 'armed') return 'info'
  return 'neutral'
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 事件时间：今天只显示 `HH:MM:SS`，更早的带 `MM-DD`。
 *
 * 与 timelineLog 里那份同名逻辑重复了一点点，但**不复用**：那份的入参约定是服务端
 * ISO 字符串 + 「同一天」判定，一旦哪天服务端改成带时区偏移的格式，改它会连带影响
 * 这份纯本地时间的行为。两处各自稳定更划算。
 */
export function formatBackgroundSyncTime(at: string | Date, now: Date = new Date()): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (sameDay) return clock
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** 结构化补充压成一行 `k=v k=v` */
export function formatBackgroundSyncData(data: Record<string, unknown> | null | undefined): string {
  if (!data) return ''
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' ')
}

export interface BackgroundSyncSummary {
  /** 成功过几次 */
  ok: number
  /** 失败过几次 */
  failed: number
  /** 最近一次成功（ISO）；从没成功过是 null */
  lastOkAt: string | null
  /** 浏览器支不支持（由日志里有没有 unsupported 事件推断） */
  supported: boolean | null
}

/**
 * 汇总。
 *
 * `supported` 是**推断**而不是直接探测：真正的判据是 `registration.sync` 是否存在，
 * 但那要拿 SW registration，面板只是读日志。日志里出现 unsupported 就说明本机登记过
 * 且失败了；有别的 kind 就说明至少走到过登记那一步。两者都没有 = 还没试过（null）。
 */
export function summarizeBackgroundSync(events: readonly BackgroundSyncEvent[]): BackgroundSyncSummary {
  let ok = 0
  let failed = 0
  let lastOkAt: string | null = null
  let sawUnsupported = false
  let sawOther = false

  for (const event of events) {
    if (event.kind === 'sync-ok') {
      ok += 1
      if (!lastOkAt || new Date(event.at).getTime() > new Date(lastOkAt).getTime()) lastOkAt = event.at
    } else if (event.kind === 'sync-failed' || event.kind === 'arm-failed') {
      failed += 1
    } else if (event.kind === 'unsupported') {
      sawUnsupported = true
    } else {
      sawOther = true
    }
  }

  let supported: boolean | null = null
  if (sawOther) supported = true
  else if (sawUnsupported) supported = false

  return { ok, failed, lastOkAt, supported }
}
