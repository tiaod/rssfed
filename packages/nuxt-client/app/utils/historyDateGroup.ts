/**
 * 历史页（最近阅读）的日期分组与阅读时刻格式化。
 *
 * 分组按**用户本地日历**切天，不按 UTC：东八区凌晨读的条目在 UTC 还是前一天，
 * 按日界切会把「今天读的」和「昨晚读的」混在一起。纯函数、无浏览器依赖，方便单测。
 */

import type { RssEntry } from '~/types/rss'

export interface HistoryDayGroup {
  /** 本地时区的日期键（YYYY-MM-DD）；readAt 缺失的老条目为空串 */
  key: string
  /** 今天 / 昨天 / 11月3日 周一 / 2025年12月31日 */
  label: string
  entries: RssEntry[]
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区的日期键（YYYY-MM-DD）；解析失败返回空串 */
export function localDayKey(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时区的当天零点（只为算「相差几天」，时间部分归零避免时分秒干扰） */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * 日期键 → 分组标题。
 *
 * 今天 / 昨天用相对说法（用户最常看的就是这两段），其余按本地日历写具体日期；
 * 跨年才带年份，同年省略（历史页大多是近期内容）。
 */
export function historyDayLabel(dayKey: string, now: Date = new Date()): string {
  if (!dayKey) return '更早'
  const [year, month, day] = dayKey.split('-').map(Number)
  if (!year || !month || !day) return '更早'

  const date = new Date(year, month - 1, day)
  const diffDays = Math.round((startOfLocalDay(now).getTime() - date.getTime()) / DAY_MS)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'

  const weekday = WEEKDAYS[date.getDay()]
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`
}

/**
 * 阅读时刻（HH:mm，本地时区）。
 *
 * 用本地时间手拼，不用 `toLocaleTimeString`：后者输出受运行环境 locale 影响，
 * 单测与线上会不一致。缺 readAt（老状态文档）返回空串，由调用方省略显示。
 */
export function readTimeLabel(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 按阅读日期把条目分组。
 *
 * 输入顺序即展示顺序（查询已按 readAt 倒序），所以只做「连续同一天合并」，
 * 不重新排序 —— 分组只在时间序上切刀，不能打乱用户「最近读过什么」的先后。
 */
export function groupEntriesByReadDay(
  entries: RssEntry[],
  now: Date = new Date()
): HistoryDayGroup[] {
  const groups: HistoryDayGroup[] = []
  for (const entry of entries) {
    const key = localDayKey(entry.readAt)
    const last = groups[groups.length - 1]
    if (last?.key === key) {
      last.entries.push(entry)
      continue
    }
    groups.push({ key, label: historyDayLabel(key, now), entries: [entry] })
  }
  return groups
}
