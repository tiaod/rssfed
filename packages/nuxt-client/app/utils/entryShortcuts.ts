/**
 * 详情面（弹窗 / 阅读栏）的动作快捷键。
 *
 * 阅读是键盘友好的场景：手不用离开键盘就能标已读、收藏、跳原文。底栏常不常驻因此没那么要紧了 ——
 * 但对鼠标用户来说，「操作栏滚到文章末尾才出现」仍然是实打实的麻烦，所以快捷键是补充，不是替代。
 * 单字母是阅读器的通行做法（m = mark read，s = star，o = open）；← / → 翻篇由各展示面自己处理，
 * 因为它和划卡、页码提示纠缠在一起，不适合收进这里。
 */
export const ENTRY_SHORTCUTS = {
  toggleRead: 'm',
  toggleStar: 's',
  openOriginal: 'o'
} as const

export type EntryShortcut = keyof typeof ENTRY_SHORTCUTS

/** 提示文案里显示的按键：拼进按钮的 title，用户才可能发现快捷键的存在 */
export const ENTRY_SHORTCUT_HINTS: Record<EntryShortcut, string> = {
  toggleRead: 'M',
  toggleStar: 'S',
  openOriginal: 'O'
}

/**
 * 事件 → 动作；不是快捷键时返回 null。
 *
 * 带 Ctrl / Cmd / Alt 的组合键一律不认：那是浏览器与系统的地盘（Ctrl+S 存网页、Cmd+M 最小化），
 * 抢过来只会让快捷键变成惊吓。焦点在输入框 / 可编辑区时由调用方先行排除。
 */
export function entryShortcutOf(event: KeyboardEvent): EntryShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = event.key.toLowerCase()
  for (const action of Object.keys(ENTRY_SHORTCUTS) as EntryShortcut[]) {
    if (key === ENTRY_SHORTCUTS[action]) return action
  }
  return null
}

/**
 * 在新窗口打开原文。
 *
 * 用 window.open 而不是 <a>：快捷键触发时没有可点的节点。noopener 必须显式带上 ——
 * 否则新页面能通过 window.opener 反向操作这个正在读的标签页。
 */
export function openOriginalInNewTab(url: string | undefined | null) {
  if (!url || typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener,noreferrer')
}
