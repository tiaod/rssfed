/**
 * 时间线右栏「阅读小结」的纯计算部分。
 *
 * 只依赖状态文档里那两个时间戳（`readAt` / `savedAt`），不碰 PouchDB、不碰 Nuxt，
 * 这样「本地日期怎么切」「跨年怎么显示」这类容易各处写歪的规则都能单测。
 *
 * 口径（与「最近阅读」页保持一致，见 usePouchDb.queryHistoryEntries）：
 *   - 一条算「读过」当且仅当 `read === true`；老状态文档没有 `readAt` 照样算读过
 *     （它出现在历史页里却没有时间戳），只是进不了任何按时间切分的桶；
 *   - `saved === true` 但 `read` 为假 = 「收藏了但还没读」，也就是待读队列。
 */

/**
 * 本模块关心的状态文档字段。
 *
 * 刻意不从 usePouchDb 里 import StateDoc：那是个未导出的内部接口，且带着整个 composable
 * 的依赖链（PouchDB、Nuxt 自动导入）。这里只要四个字段，按结构兼容即可 —— 单测也就能
 * 直接喂普通对象。
 */
export interface EntryStateLike {
  read?: boolean
  readAt?: string
  saved?: boolean
  savedAt?: string
}

/** 右栏要显示的几个数字 */
export interface ReadingDigest {
  /** 今天（本地时区的自然日）读过的条数 */
  today: number
  /** 最近 7 天（含今天）读过的条数 */
  week: number
  /** 读过的总条数 */
  total: number
  /** 收藏总数 */
  saved: number
  /** 收藏了但还没读的条数（待读队列） */
  savedUnread: number
}

/** 本地自然日的起点（今天 00:00 的时刻） */
export function startOfDay(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * 最近 7 天的起点：今天 00:00 往前推 6 天。
 *
 * 不是「现在减 7×24 小时」—— 那样早上打开时窗口会漏掉 7 天前上午读的内容，
 * 而「最近 7 天」在用户眼里是 7 个自然日。
 */
export function startOfWeek(now: Date = new Date()): number {
  return startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6))
}

/** 状态文档里的一个时间戳解析成毫秒；脏值当作「没有时间戳」返回 null */
function timestampOf(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * 把状态文档汇总成右栏那几个数字。
 *
 * 只扫一遍：历史页 / 收藏页各自要全量列出来，右栏只要计数，没必要为三个数字读三遍状态库
 * （调用方负责把那一次 allDocs 的结果喂进来）。
 */
export function summarizeReading(
  states: ReadonlyArray<EntryStateLike>,
  now: Date = new Date()
): ReadingDigest {
  const todayStart = startOfDay(now)
  const weekStart = startOfWeek(now)
  let today = 0
  let week = 0
  let total = 0
  let saved = 0
  let savedUnread = 0

  for (const state of states) {
    const read = state.read === true
    const starred = state.saved === true

    if (read) {
      total++
      // 没有 readAt 的老文档算「读过」但归不进任何时间段：宁可少报，不要瞎报成今天
      const at = timestampOf(state.readAt)
      if (at !== null) {
        if (at >= todayStart) today++
        if (at >= weekStart) week++
      }
    }
    if (starred) {
      saved++
      if (!read) savedUnread++
    }
  }

  return { today, week, total, saved, savedUnread }
}
