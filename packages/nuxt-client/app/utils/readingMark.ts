/**
 * 阅读基准：记住「上次列表的第一条是谁」，刷新浏览器后据此把新内容挡在提示条里。
 *
 * 只存 id 和窗口深度，不存条目内容——刷新后照常从本地库重查，已读/收藏状态与封面图都是最新的。
 * 放 sessionStorage 而不是 localStorage：换标签页算新会话，各标签页的阅读位置互不干扰。
 * storage 不可用（隐私模式、单测环境）时静默降级为「刷新后不做恢复」，当前页面的读写不受影响。
 */
export interface ReadingMark {
  /** 基准归属账号；换账号后基准属于上一个账号，不能用 */
  accountId: string | null
  /** 上次列表的第一条（最新的一条）：比它新的内容要先收进提示条 */
  headId: string
  /** 上次的查询窗口深度，回来照旧 */
  displayLimit: number
}

const MARK_PREFIX = 'rssfed:list-mark:'

export function readReadingMark(stateKey: string, accountId: string | null): ReadingMark | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(`${MARK_PREFIX}${stateKey}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ReadingMark
    if (!parsed || typeof parsed.headId !== 'string' || !parsed.headId) return null
    if ((parsed.accountId ?? null) !== accountId) return null
    return parsed
  } catch {
    return null
  }
}

/** 写入基准；传 null 表示清除（列表空了、或基准已经对不上本地库） */
export function writeReadingMark(stateKey: string, mark: ReadingMark | null): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (mark) sessionStorage.setItem(`${MARK_PREFIX}${stateKey}`, JSON.stringify(mark))
    else sessionStorage.removeItem(`${MARK_PREFIX}${stateKey}`)
  } catch {
    // 写不进去就退化成「刷新后不做恢复」，不影响当前会话
  }
}
