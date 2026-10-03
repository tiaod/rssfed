import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RssEntry } from '../../types/rss'
import { useEntryActions } from '../../composables/useEntryActions'

/**
 * 单条的就地动作：标为已读 / 未读、收藏。
 *
 * 详情工具栏（useEntryDetail）与信息流操作栏（EntrySocialItem）共用这一份，所以这里盯的是
 * 「写库调对了没有、结果有没有就地写回列表里那个对象、失败会不会留下假状态、连点会不会重复写」。
 */

const H = vi.hoisted(() => ({
  markRead: vi.fn(async () => {}),
  toggleSaved: vi.fn(async () => true),
  toast: vi.fn()
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.usePouchDb = () => ({ markRead: H.markRead, toggleSaved: H.toggleSaved })
testGlobals.useToast = () => ({ add: H.toast })

function makeEntry(over: Partial<RssEntry> = {}): RssEntry {
  return {
    id: 'entry-1',
    feedId: 'feed-1',
    title: '文章标题',
    url: 'https://a.example/1',
    publishedAt: '2026-07-01T00:00:00.000Z',
    insertedAt: '2026-07-01T00:00:00.000Z',
    feed: {
      id: 'feed-1',
      title: '某科技周刊',
      siteUrl: 'https://a.example',
      feedUrl: 'https://a.example/feed',
      lastFetchedAt: ''
    },
    starred: false,
    read: false,
    readingTime: 0,
    ...over
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  H.markRead.mockResolvedValue(undefined)
  H.toggleSaved.mockResolvedValue(true)
})

describe('useEntryActions 标为已读 / 未读', () => {
  it('未读 → 已读：写库成功后把结果写回条目本身（列表共用引用）', async () => {
    const entry = makeEntry({ read: false })
    const { toggleRead, readBusy } = useEntryActions(() => entry)

    await toggleRead()

    expect(H.markRead).toHaveBeenCalledWith('entry-1', 'feed-1', true)
    expect(entry.read).toBe(true)
    expect(readBusy.value).toBe(false)
  })

  it('已读 → 未读：传 false', async () => {
    const entry = makeEntry({ read: true })

    await useEntryActions(() => entry).toggleRead()

    expect(H.markRead).toHaveBeenCalledWith('entry-1', 'feed-1', false)
    expect(entry.read).toBe(false)
  })

  it('写库失败：弹出错误提示，条目状态不跟着变（不能显示没落盘的状态）', async () => {
    H.markRead.mockRejectedValue(new Error('离线'))
    const entry = makeEntry({ read: false })

    await useEntryActions(() => entry).toggleRead()

    expect(entry.read).toBe(false)
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })

  it('连点：写入还在飞行中就忽略后续点击（不会写两次相反的意图）', async () => {
    let release: (() => void) | null = null
    H.markRead.mockImplementation(() => new Promise<void>((resolve) => {
      release = () => resolve()
    }))
    const entry = makeEntry({ read: false })
    const { toggleRead, readBusy } = useEntryActions(() => entry)

    const first = toggleRead()
    await toggleRead() // 飞行中：直接返回
    expect(readBusy.value).toBe(true)
    expect(H.markRead).toHaveBeenCalledTimes(1)

    release!()
    await first
    expect(entry.read).toBe(true)
  })

  it('没有条目时是空操作（详情面还没选中任何一篇）', async () => {
    await useEntryActions(() => null).toggleRead()

    expect(H.markRead).not.toHaveBeenCalled()
  })
})

describe('useEntryActions 收藏', () => {
  it('打开收藏：切换后的值以本地库返回为准', async () => {
    H.toggleSaved.mockResolvedValue(true)
    const entry = makeEntry({ starred: false })

    await useEntryActions(() => entry).toggleStar()

    expect(H.toggleSaved).toHaveBeenCalledWith('entry-1', 'feed-1')
    expect(entry.starred).toBe(true)
  })

  it('取消收藏：同样认本地库返回值', async () => {
    H.toggleSaved.mockResolvedValue(false)
    const entry = makeEntry({ starred: true })

    await useEntryActions(() => entry).toggleStar()

    expect(entry.starred).toBe(false)
  })

  it('写库失败：弹提示、星标不变', async () => {
    H.toggleSaved.mockRejectedValue(new Error('离线'))
    const entry = makeEntry({ starred: false })

    await useEntryActions(() => entry).toggleStar()

    expect(entry.starred).toBe(false)
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })
})
