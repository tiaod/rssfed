import { describe, it, expect, afterEach, vi } from 'vitest'
import { ENTRY_SHORTCUT_HINTS, ENTRY_SHORTCUTS, entryShortcutOf, openOriginalInNewTab } from '../../utils/entryShortcuts'

/**
 * 阅读面的键盘快捷键。
 *
 * 这里钉两件事：带修饰键的按键不能当快捷键（否则 Ctrl+M / ⌘+S 会被吃掉），
 * 以及大小写无关（开着 Caps Lock 也得能用）。
 */
describe('entryShortcutOf', () => {
  function key(k: string, mods: Partial<KeyboardEvent> = {}) {
    return { key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent
  }

  it('m / s / o 分别对应已读、收藏、开原文', () => {
    expect(entryShortcutOf(key('m'))).toBe('toggleRead')
    expect(entryShortcutOf(key('s'))).toBe('toggleStar')
    expect(entryShortcutOf(key('o'))).toBe('openOriginal')
    expect(ENTRY_SHORTCUTS).toEqual({ toggleRead: 'm', toggleStar: 's', openOriginal: 'o' })
  })

  it('大写同样认（Caps Lock 开着不该失灵）', () => {
    expect(entryShortcutOf(key('M'))).toBe('toggleRead')
    expect(entryShortcutOf(key('S'))).toBe('toggleStar')
    expect(entryShortcutOf(key('O'))).toBe('openOriginal')
  })

  it('带 Ctrl / Meta / Alt 的组合键一律不认：那是浏览器与系统的快捷键', () => {
    expect(entryShortcutOf(key('m', { ctrlKey: true }))).toBeNull()
    expect(entryShortcutOf(key('s', { metaKey: true }))).toBeNull()
    expect(entryShortcutOf(key('o', { altKey: true }))).toBeNull()
  })

  it('别的键不认', () => {
    expect(entryShortcutOf(key('k'))).toBeNull()
    expect(entryShortcutOf(key('ArrowLeft'))).toBeNull()
  })

  it('提示文字与键位一致（按钮 title 里带的就是它）', () => {
    expect(ENTRY_SHORTCUT_HINTS.toggleRead.toLowerCase()).toBe(ENTRY_SHORTCUTS.toggleRead)
    expect(ENTRY_SHORTCUT_HINTS.toggleStar.toLowerCase()).toBe(ENTRY_SHORTCUTS.toggleStar)
    expect(ENTRY_SHORTCUT_HINTS.openOriginal.toLowerCase()).toBe(ENTRY_SHORTCUTS.openOriginal)
  })
})

describe('openOriginalInNewTab', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('开新标签页时带上 noopener,noreferrer（原文来自第三方，不能让它拿到 opener）', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    openOriginalInNewTab('https://example.com/a')

    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  })

  it('没有原文链接时什么都不做（不弹一个空白标签页）', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    openOriginalInNewTab(undefined)
    openOriginalInNewTab(null)
    openOriginalInNewTab('')

    expect(open).not.toHaveBeenCalled()
  })
})
