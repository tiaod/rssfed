/**
 * 同步日志面板的纯展示逻辑（格式化 / 徽标映射 / 源状态汇总）。
 *
 * 抽出来是为了能单测：时间格式与"同一个 kind 在不同 level 下显示什么颜色"这类东西
 * 在页面里写死很容易各处不一致，而它们又是排查时最先看的东西。
 *
 * 面板里的「一轮」现在是**抓取**（新模型没有聚合扇出，见 ARCHITECTURE.md）：
 * 服务端每一轮只记「订阅几个源、几个到期、新增/裁剪/失败各多少」。
 */
import type { TimelineSourceState } from '~/types/timeline-log'

/**
 * kind → 徽标文案（服务端新增 kind 时这里没命中就原样显示）。
 *
 * `reconcile` / `rebuild` / `source-sync` / `error` 是**旧模型的历史行**：重构后不再产生，
 * 但老记录还在库里，标签保持原样，免得用户看到一排「unknown」。
 */
const EVENT_LABELS: Record<string, string> = {
  'fetch': '抓取',
  'reconcile': '汇聚',
  'rebuild': '重建',
  'source-sync': '首搬',
  'error': '失败'
}

export function timelineEventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind
}

/** 徽标颜色：失败/警告一律按 level 走，其余按类型区分（日常轮次不上色） */
export function timelineEventColor(kind: string, level: string): 'neutral' | 'info' | 'warning' | 'error' {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  // 只剩历史行会命中：新模型没有"首搬"
  if (kind === 'source-sync') return 'info'
  return 'neutral'
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 事件时间：今天只显示 `HH:MM:SS`（一轮抓取的具体时刻），更早的带上 `MM-DD`。
 *
 * 用 Date 的本地时间取值手拼，不用 `toLocaleTimeString` —— 后者的输出受运行环境 locale 影响，
 * 单测里没法稳定断言。
 */
export function formatTimelineEventTime(at: string | Date, now: Date = new Date()): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (sameDay) return clock
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** 同一天里两次事件的相对时间（"3 分钟前"），只用于"上次同步"这种概览行 */
export function formatSince(at: string | Date | null, now: Date = new Date()): string {
  if (!at) return '从未'
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return formatTimelineEventTime(date, now)
}

/**
 * 事件的结构化补充压成一行 `k=v k=v`（面板里挂在小字后面）。
 *
 * 不直接 JSON.stringify：排查时要的是一眼扫过去，花括号和引号只是噪音。
 */
export function formatTimelineEventData(data: Record<string, unknown> | null | undefined): string {
  if (!data) return ''
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' ')
}

export interface TimelineSourceSummary {
  total: number
  errors: number
  /** 最近一次抓取时刻（ISO）；没有任何源抓过就是 null */
  lastFetchedAt: string | null
}

/**
 * 源状态汇总（面板概览行用）。
 *
 * 输入是订阅列表里的当前状态（用户自己库里的 `_local/schedule`），**不是**轮次流水：
 * 流水说「这一轮失败了 2 个」，这里说「现在还有哪几个坏着」，两件事都要能回答。
 */
export function summarizeTimelineSources(sources: TimelineSourceState[]): TimelineSourceSummary {
  let errors = 0
  let last: number | null = null
  for (const source of sources) {
    if (source.status === 'error' || source.errorMessage) errors += 1
    if (source.lastFetchedAt) {
      const time = new Date(source.lastFetchedAt).getTime()
      if (!Number.isNaN(time) && (last === null || time > last)) last = time
    }
  }
  return {
    total: sources.length,
    errors,
    lastFetchedAt: last === null ? null : new Date(last).toISOString()
  }
}
